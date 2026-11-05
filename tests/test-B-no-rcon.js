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
const BOT_COUNT = parseInt(process.argv[3] || '5');
const ACCOUNT_START = parseInt(process.argv[4] || '100');

if (!TARGET) {
	console.log('Kullanım: node tests/test-B-no-rcon.js <targetSteamID64> [botCount=5]');
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

setTimeout(() => { log('Self-destruct (3dk)'); process.exit(1); }, 180000).unref();

async function testBot(accountIndex, serverSteamID, useRcon) {
	const account = accounts[accountIndex];
	const proxy = proxies.length > 0 ? proxies[accountIndex % proxies.length] : null;
	const steamOpts = { autoRelogin: false };
	if (proxy) {
		if (proxy.startsWith('socks')) steamOpts.socksProxy = proxy;
		else steamOpts.httpProxy = proxy;
	}

	const bot = new SteamUser(steamOpts);
	let commendResult = null;
	const label = useRcon ? 'RCON' : 'NO-RCON';

	bot.on('receivedFromGC', (appid, type, body) => {
		if (appid !== APP_ID || type !== 9122) return;
		try {
			const r = ResponseMsg.toObject(ResponseMsg.decode(body), { defaults: true, longs: Number });
			commendResult = r;
		} catch {}
	});

	const totalStart = Date.now();

	try {
		await new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error('Login timeout')), 30000);
			bot.logOn({
				accountName: account.username,
				password: account.password,
				twoFactorCode: (account.sharedSecret && account.sharedSecret.length > 5)
					? SteamTotp.getAuthCode(account.sharedSecret) : undefined
			});
			bot.once('loggedOn', () => { clearTimeout(t); resolve(); });
			bot.once('error', (err) => { clearTimeout(t); reject(err); });
		});
		try { await bot.requestFreeLicense(APP_ID); } catch {}

		bot.gamesPlayed(APP_ID);
		await wait(3000);

		const sendHello = () => {
			const p = HelloMsg.encode(HelloMsg.create({
				version: GC_VERSION, client_session_need: 1, client_launcher: 0, steam_launcher: 0
			})).finish();
			bot.sendToGC(APP_ID, 4006, {}, Buffer.from(p));
		};
		sendHello();
		await new Promise((resolve) => {
			const t = setTimeout(() => resolve(false), 10000);
			const h = (appid, type) => {
				if (appid === APP_ID && type === 9110) {
					clearTimeout(t); bot.removeListener('receivedFromGC', h); resolve(true);
				}
			};
			bot.on('receivedFromGC', h);
		});

		const { sessionTicket } = await bot.createAuthSessionTicket(APP_ID);
		const ticketHex = sessionTicket.toString('hex');

		if (useRcon) {
			const rcon = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
			await rcon.connect();
			await rcon.execute(`css_auth_end ${bot.steamID.getSteamID64()}`);
			const CHUNK = 400;
			for (let i = 0; i < ticketHex.length; i += CHUNK) {
				await rcon.execute(`css_auth_data ${ticketHex.slice(i, i + CHUNK)}`);
			}
			await rcon.execute(`css_auth_go ${bot.steamID.getSteamID64()}`);
			rcon.disconnect();
		}

		await wait(useRcon ? 3000 : 1000);
		const activeTickets = bot._activeAuthTickets;
		if (activeTickets) {
			const t = activeTickets.find(t => t.gameid == APP_ID);
			if (t) { t.steamid = serverSteamID; t.estate = 2; }
		}
		bot.gamesPlayed({ game_id: APP_ID, steam_id_gs: serverSteamID });
		await bot._sendAuthList(APP_ID);
		await wait(2000);

		sendHello();
		await new Promise((resolve) => {
			const t = setTimeout(() => resolve(false), 10000);
			const h = (appid, type) => {
				if (appid === APP_ID && type === 9110) {
					clearTimeout(t); bot.removeListener('receivedFromGC', h); resolve(true);
				}
			};
			bot.on('receivedFromGC', h);
		});
		await wait(1000);

		const commendPayload = CommendMsg.encode(CommendMsg.create({
			account_id: targetAccountId, match_id: 0,
			commendation: { cmd_friendly: 1, cmd_teaching: 1, cmd_leader: 1 }, tokens: 0
		})).finish();

		const sendTime = Date.now();
		bot.sendToGC(APP_ID, 9121, {}, Buffer.from(commendPayload));

		for (let w = 0; w < 16; w++) {
			await wait(500);
			if (commendResult) break;
		}
		if (!commendResult) {
			bot.sendToGC(APP_ID, 9121, {}, Buffer.from(commendPayload));
			for (let w = 0; w < 6; w++) {
				await wait(500);
				if (commendResult) break;
			}
		}

		const elapsed = Date.now() - sendTime;
		const total = Date.now() - totalStart;

		if (useRcon) {
			try {
				const rcon2 = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
				await rcon2.connect();
				await rcon2.execute(`css_auth_end ${bot.steamID.getSteamID64()}`);
				rcon2.disconnect();
			} catch {}
		}
		bot.logOff();

		return {
			success: commendResult !== null,
			tokens: commendResult ? commendResult.tokens : null,
			responseMs: elapsed,
			totalMs: total,
			account: account.username,
			mode: label
		};
	} catch (err) {
		try { bot.logOff(); } catch {}
		return { success: false, error: err.message, account: account.username, mode: label, totalMs: Date.now() - totalStart };
	}
}

async function main() {
	GC_VERSION = await fetchGCVersion(null, GC_VERSION).catch(() => GC_VERSION);
	log(`Target: ${TARGET} (accountId=${targetAccountId})`);
	log(`GC Version: ${GC_VERSION}`);

	const rcon0 = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
	await rcon0.connect();
	const status = await rcon0.execute('status');
	const m = status.match(/steamid\s*:\s*(\d+)/i) || status.match(/(\d{15,})/);
	const serverSteamID = m ? m[1] : null;
	rcon0.disconnect();
	if (!serverSteamID) throw new Error('Server SteamID alınamadı');
	log(`Server SteamID: ${serverSteamID}`);

	log(`\n${'═'.repeat(60)}`);
	log(`TEST 1: RCON İLE — ${BOT_COUNT} bot (kontrol grubu)`);
	log(`${'═'.repeat(60)}`);

	const rconResults = [];
	for (let i = 0; i < BOT_COUNT; i++) {
		log(`  [${i + 1}/${BOT_COUNT}] ${accounts[ACCOUNT_START + i].username} — RCON ile...`);
		const r = await testBot(ACCOUNT_START + i, serverSteamID, true);
		rconResults.push(r);
		log(`  → ${r.success ? '✓' : '✗'} ${r.success ? `tokens=${r.tokens} ${r.responseMs}ms` : r.error || 'timeout'} (toplam: ${r.totalMs}ms)`);
		await wait(1000);
	}

	log(`\n${'═'.repeat(60)}`);
	log(`TEST 2: RCON OLMADAN — ${BOT_COUNT} bot`);
	log(`${'═'.repeat(60)}`);

	const noRconResults = [];
	for (let i = 0; i < BOT_COUNT; i++) {
		const idx = ACCOUNT_START + BOT_COUNT + i;
		log(`  [${i + 1}/${BOT_COUNT}] ${accounts[idx].username} — RCON olmadan...`);
		const r = await testBot(idx, serverSteamID, false);
		noRconResults.push(r);
		log(`  → ${r.success ? '✓' : '✗'} ${r.success ? `tokens=${r.tokens} ${r.responseMs}ms` : r.error || 'timeout'} (toplam: ${r.totalMs}ms)`);
		await wait(1000);
	}

	const rconOK = rconResults.filter(r => r.success).length;
	const noRconOK = noRconResults.filter(r => r.success).length;

	log(`\n${'═'.repeat(60)}`);
	log(`KARŞILAŞTIRMA`);
	log(`${'═'.repeat(60)}`);
	log(`  RCON ile:    ${rconOK}/${BOT_COUNT} başarılı`);
	log(`  RCON olmadan: ${noRconOK}/${BOT_COUNT} başarılı`);

	if (noRconOK > 0 && noRconOK >= rconOK) {
		log(`  RCON'suz yöntem çalışıyor! RCON auth gereksiz olabilir.`);
	} else if (noRconOK === 0 && rconOK > 0) {
		log(`  RCON auth zorunlu — RCON'suz yöntem çalışmıyor.`);
	} else {
		log(`  Her iki yöntem de benzer sonuç verdi.`);
	}

	process.exit(0);
}

main().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
