const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const SteamID = require('steamid');
const path = require('path');
const fs = require('fs');
const loadProtos = require('../helpers/Protos');
const Rcon = require('../helpers/Rcon');
const { fetchGCVersion } = require('../helpers/ServerValidation');

const config = require('../config.json');
const accounts = require('../accounts.json');
const proxiesData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'web', 'proxies.json'), 'utf8'));
const proxies = proxiesData.proxies || [];

const TARGET = process.argv[2];
const ACCOUNT_START = parseInt(process.argv[3] || '200');

if (!TARGET) {
	console.log('Kullanım: node tests/test-D-rapid-fire.js <targetSteamID64> [accountStart=200]');
	process.exit(1);
}

const targetAccountId = new SteamID(TARGET).accountid;
const APP_ID = 730;
let GC_VERSION = 2000771;
const SERVER_IP = config.server.ip;
const RCON_PORT = parseInt(config.server.port || '27015');
const RCON_PASS = config.server.password;

const protos = loadProtos([
	{ name: 'cs2', protos: path.join(__dirname, '..', 'protobufs', 'cs2') },
]);
const HelloMsg = protos.cs2.lookupType('CMsgClientHello');
const CommendMsg = protos.cs2.lookupType('CMsgGCCStrike15_v2_ClientCommendPlayer');
const ResponseMsg = protos.cs2.lookupType('CMsgGCCStrike15_v2_ClientReportResponse');

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg) { console.log(`[${new Date().toLocaleTimeString('tr-TR')}] ${msg}`); }

setTimeout(() => { log('Self-destruct (5dk)'); process.exit(1); }, 300000).unref();

async function phase1_fullDebug(serverSteamID) {
	log(`\n${'═'.repeat(60)}`);
	log(`PHASE 1: Full GC Debug — Tüm mesajları logla`);
	log(`${'═'.repeat(60)}`);

	const account = accounts[ACCOUNT_START];
	const proxy = proxies.length > 0 ? proxies[0] : null;
	const steamOpts = { autoRelogin: false };
	if (proxy) {
		if (proxy.startsWith('socks')) steamOpts.socksProxy = proxy;
		else steamOpts.httpProxy = proxy;
	}

	const bot = new SteamUser(steamOpts);
	let commendResult = null;
	const gcMessages = [];

	bot.on('receivedFromGC', (appid, type, body) => {
		if (appid !== APP_ID) return;
		const entry = { type, time: Date.now(), size: body.length };

		if (type === 9122) {
			try {
				const r = ResponseMsg.toObject(ResponseMsg.decode(body), { defaults: true, longs: Number });
				entry.decoded = r;
				commendResult = r;
			} catch (e) { entry.decodeError = e.message; }
		}

		gcMessages.push(entry);
		log(`  📨 GC MSG type=${type} size=${body.length}${entry.decoded ? ' → ' + JSON.stringify(entry.decoded) : ''}`);
	});

	await new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('Login timeout')), 30000);
		bot.logOn({
			accountName: account.username, password: account.password,
			twoFactorCode: (account.sharedSecret && account.sharedSecret.length > 5)
				? SteamTotp.getAuthCode(account.sharedSecret) : undefined
		});
		bot.once('loggedOn', () => { clearTimeout(t); resolve(); });
		bot.once('error', (err) => { clearTimeout(t); reject(err); });
	});
	try { await bot.requestFreeLicense(APP_ID); } catch {}
	log(`  Login OK: ${account.username}`);

	bot.gamesPlayed(APP_ID);
	await wait(3000);
	const sendHello = () => {
		const p = HelloMsg.encode(HelloMsg.create({
			version: GC_VERSION, client_session_need: 1, client_launcher: 0, steam_launcher: 0
		})).finish();
		bot.sendToGC(APP_ID, 4006, {}, Buffer.from(p));
	};
	log(`  Hello gönderiyor...`);
	sendHello();
	await new Promise((resolve) => {
		const t = setTimeout(() => resolve(false), 10000);
		const h = (appid, type) => {
			if (appid === APP_ID && type === 9110) { clearTimeout(t); bot.removeListener('receivedFromGC', h); resolve(true); }
		};
		bot.on('receivedFromGC', h);
	});

	const { sessionTicket } = await bot.createAuthSessionTicket(APP_ID);
	const ticketHex = sessionTicket.toString('hex');
	const rcon = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
	await rcon.connect();
	await rcon.execute(`css_auth_end ${bot.steamID.getSteamID64()}`);
	const CHUNK = 400;
	for (let i = 0; i < ticketHex.length; i += CHUNK) {
		await rcon.execute(`css_auth_data ${ticketHex.slice(i, i + CHUNK)}`);
	}
	const authResp = await rcon.execute(`css_auth_go ${bot.steamID.getSteamID64()}`);
	log(`  RCON css_auth_go yanıtı: "${authResp.trim()}"`);
	rcon.disconnect();

	await wait(3000);
	const activeTickets = bot._activeAuthTickets;
	if (activeTickets) {
		const t = activeTickets.find(t => t.gameid == APP_ID);
		if (t) {
			t.steamid = serverSteamID; t.estate = 2;
			log(`  Ticket bound: gameid=${t.gameid} steamid=${t.steamid} estate=${t.estate}`);
		} else {
			log(`  ⚠ Ticket bulunamadı! Mevcut tickets: ${JSON.stringify(activeTickets.map(t => ({gameid: t.gameid, estate: t.estate})))}`);
		}
	}
	bot.gamesPlayed({ game_id: APP_ID, steam_id_gs: serverSteamID });
	await bot._sendAuthList(APP_ID);
	await wait(2000);

	log(`  İkinci Hello gönderiyor...`);
	gcMessages.length = 0;
	sendHello();
	await new Promise((resolve) => {
		const t = setTimeout(() => resolve(false), 10000);
		const h = (appid, type) => {
			if (appid === APP_ID && type === 9110) { clearTimeout(t); bot.removeListener('receivedFromGC', h); resolve(true); }
		};
		bot.on('receivedFromGC', h);
	});
	await wait(1000);

	log(`  Commend gönderiyor...`);
	gcMessages.length = 0;
	commendResult = null;

	const commendPayload = CommendMsg.encode(CommendMsg.create({
		account_id: targetAccountId, match_id: 0,
		commendation: { cmd_friendly: 1, cmd_teaching: 1, cmd_leader: 1 }, tokens: 0
	})).finish();

	const sendTime = Date.now();
	bot.sendToGC(APP_ID, 9121, {}, Buffer.from(commendPayload));

	for (let w = 0; w < 30; w++) {
		await wait(500);
		if (commendResult) break;
	}

	const elapsed = Date.now() - sendTime;
	log(`  Sonuç: ${commendResult ? '✓ OK' : '✗ TIMEOUT'} — ${elapsed}ms`);
	log(`  Bu sürede gelen GC mesajları: ${gcMessages.length}`);
	for (const msg of gcMessages) {
		log(`    type=${msg.type} size=${msg.size}${msg.decoded ? ' data=' + JSON.stringify(msg.decoded) : ''}`);
	}

	try {
		const rcon2 = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
		await rcon2.connect();
		await rcon2.execute(`css_auth_end ${bot.steamID.getSteamID64()}`);
		rcon2.disconnect();
	} catch {}
	bot.logOff();

	return commendResult !== null;
}

async function phase2_rapidFire(serverSteamID, count) {
	log(`\n${'═'.repeat(60)}`);
	log(`PHASE 2: ${count} bot paralel login → rapid fire commend (500ms aralık)`);
	log(`${'═'.repeat(60)}`);

	const startIdx = ACCOUNT_START + 1;
	const botEntries = [];

	log(`  Login başlıyor...`);
	const loginStart = Date.now();

	const loginPromises = [];
	for (let i = 0; i < count; i++) {
		const idx = startIdx + i;
		const account = accounts[idx];
		const proxy = proxies.length > 0 ? proxies[idx % proxies.length] : null;
		const steamOpts = { autoRelogin: false };
		if (proxy) {
			if (proxy.startsWith('socks')) steamOpts.socksProxy = proxy;
			else steamOpts.httpProxy = proxy;
		}

		loginPromises.push((async () => {
			const bot = new SteamUser(steamOpts);
			let commendResult = null;

			bot.on('receivedFromGC', (appid, type, body) => {
				if (appid !== APP_ID || type !== 9122) return;
				try {
					const r = ResponseMsg.toObject(ResponseMsg.decode(body), { defaults: true, longs: Number });
					commendResult = r;
				} catch {}
			});

			try {
				await new Promise((resolve, reject) => {
					const t = setTimeout(() => reject(new Error('Login timeout')), 30000);
					bot.logOn({
						accountName: account.username, password: account.password,
						twoFactorCode: (account.sharedSecret && account.sharedSecret.length > 5)
							? SteamTotp.getAuthCode(account.sharedSecret) : undefined
					});
					bot.once('loggedOn', () => { clearTimeout(t); resolve(); });
					bot.once('error', (err) => { clearTimeout(t); reject(err); });
				});
				try { await bot.requestFreeLicense(APP_ID); } catch {}

				bot.gamesPlayed(APP_ID);
				await wait(3000);
				const p = HelloMsg.encode(HelloMsg.create({
					version: GC_VERSION, client_session_need: 1, client_launcher: 0, steam_launcher: 0
				})).finish();
				bot.sendToGC(APP_ID, 4006, {}, Buffer.from(p));
				await new Promise((resolve) => {
					const t = setTimeout(() => resolve(false), 10000);
					const h = (appid, type) => {
						if (appid === APP_ID && type === 9110) {
							clearTimeout(t); bot.removeListener('receivedFromGC', h); resolve(true);
						}
					};
					bot.on('receivedFromGC', h);
				});

				return { bot, account, idx, getResult: () => commendResult, resetResult: () => { commendResult = null; }, ready: true };
			} catch (err) {
				try { bot.logOff(); } catch {}
				return { account, idx, ready: false, error: err.message };
			}
		})());
	}

	const entries = await Promise.all(loginPromises);
	const ready = entries.filter(e => e.ready);
	log(`  Login: ${ready.length}✓ ${entries.length - ready.length}✗ — ${((Date.now() - loginStart) / 1000).toFixed(1)}s`);

	log(`  RCON auth başlıyor...`);
	const authed = [];
	for (const entry of ready) {
		try {
			const { bot } = entry;
			const { sessionTicket } = await bot.createAuthSessionTicket(APP_ID);
			const ticketHex = sessionTicket.toString('hex');

			const rcon = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
			await rcon.connect();
			await rcon.execute(`css_auth_end ${bot.steamID.getSteamID64()}`);
			const CHUNK = 400;
			for (let i = 0; i < ticketHex.length; i += CHUNK) {
				await rcon.execute(`css_auth_data ${ticketHex.slice(i, i + CHUNK)}`);
			}
			await rcon.execute(`css_auth_go ${bot.steamID.getSteamID64()}`);
			await rcon.execute(`css_auth_end ${bot.steamID.getSteamID64()}`);
			rcon.disconnect();

			await wait(2000);
			const activeTickets = bot._activeAuthTickets;
			if (activeTickets) {
				const t = activeTickets.find(t => t.gameid == APP_ID);
				if (t) { t.steamid = serverSteamID; t.estate = 2; }
			}
			bot.gamesPlayed({ game_id: APP_ID, steam_id_gs: serverSteamID });
			await bot._sendAuthList(APP_ID);

			authed.push(entry);
		} catch (err) {
			log(`    ${entry.account.username} auth hatası: ${err.message}`);
		}
	}
	log(`  Auth: ${authed.length} bot hazır`);

	await wait(2000);
	for (const entry of authed) {
		const p = HelloMsg.encode(HelloMsg.create({
			version: GC_VERSION, client_session_need: 1, client_launcher: 0, steam_launcher: 0
		})).finish();
		entry.bot.sendToGC(APP_ID, 4006, {}, Buffer.from(p));
	}
	await wait(3000);

	log(`  Rapid fire commend başlıyor...`);
	const commendPayload = CommendMsg.encode(CommendMsg.create({
		account_id: targetAccountId, match_id: 0,
		commendation: { cmd_friendly: 1, cmd_teaching: 1, cmd_leader: 1 }, tokens: 0
	})).finish();

	for (const entry of authed) {
		entry.resetResult();
		entry.bot.sendToGC(APP_ID, 9121, {}, Buffer.from(commendPayload));
		await wait(500);
	}

	log(`  10s bekleniyor — yanıtlar toplanıyor...`);
	await wait(10000);

	let ok = 0, fail = 0;
	for (const entry of authed) {
		const r = entry.getResult();
		if (r) {
			ok++;
			log(`  ${entry.account.username} ✓ tokens=${r.tokens}`);
		} else {
			fail++;
			log(`  ${entry.account.username} ✗ timeout`);
		}
	}

	log(`  Rapid fire sonuç: ${ok}✓ ${fail}✗ / ${authed.length}`);

	for (const entry of ready) {
		try { entry.bot.logOff(); } catch {}
	}

	return { ok, fail, total: authed.length };
}

async function main() {
	GC_VERSION = await fetchGCVersion(null, GC_VERSION).catch(() => GC_VERSION);
	log(`Target: ${TARGET} (accountId=${targetAccountId})`);

	const rcon0 = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
	await rcon0.connect();
	const status = await rcon0.execute('status');
	const m = status.match(/steamid\s*:\s*(\d+)/i) || status.match(/(\d{15,})/);
	const serverSteamID = m ? m[1] : null;
	rcon0.disconnect();
	if (!serverSteamID) throw new Error('Server SteamID alınamadı');
	log(`Server SteamID: ${serverSteamID}`);

	const p1ok = await phase1_fullDebug(serverSteamID);
	log(`\n⏳ 30s bekleme...`);
	await wait(30000);

	const p2 = await phase2_rapidFire(serverSteamID, 10);

	log(`\n${'═'.repeat(60)}`);
	log(`ÖZET — Test D`);
	log(`${'═'.repeat(60)}`);
	log(`  Phase 1 (Full Debug): ${p1ok ? '✓' : '✗'}`);
	log(`  Phase 2 (Rapid Fire): ${p2.ok}/${p2.total}`);

	if (p2.ok === p2.total) {
		log(`  Rapid fire %100 başarılı — pre-login + batch auth + hızlı commend ÇALIŞIYOR!`);
	} else if (p2.ok > 0) {
		log(`  Kısmi başarı — GC ${p2.ok} commend sonra throttle'a giriyor`);
	} else {
		log(`  Rapid fire başarısız — GC tüm commend'leri reddetti`);
	}

	process.exit(0);
}

main().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
