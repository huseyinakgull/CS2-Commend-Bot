const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const SteamID = require('steamid');
const path = require('path');
const fs = require('fs');
const loadProtos = require('./helpers/Protos');
const Rcon = require('./helpers/Rcon');
const { validateServerSteamID, fetchGCVersion } = require('./helpers/ServerValidation');

const config = require('./config.json');
const accounts = require('./accounts.json');

const TARGET = process.argv[2];
const COUNT = parseInt(process.argv[3] || '3');
const START_INDEX = parseInt(process.argv[4] || '10');

if (!TARGET) {
	console.log('Kullanım: node test-validate.js <hedefSteamID64> [sayı] [başlangıçIndex]');
	console.log('Örnek:    node test-validate.js 76561198012345678 3 10');
	process.exit(1);
}

const SERVER_IP = config.server.ip;
const RCON_PORT = parseInt(config.server.port || '27015');
const RCON_PASS = config.server.password;
const APP_ID = 730;
let GC_VERSION = 2000771;

const targetAccountId = new SteamID(TARGET).accountid;

const protos = loadProtos([
	{ name: 'cs2', protos: path.join(__dirname, 'protobufs', 'cs2') },
]);
const HelloMsg = protos.cs2.lookupType('CMsgClientHello');
const WelcomeMsg = protos.cs2.lookupType('CMsgClientWelcome');
const CommendMsg = protos.cs2.lookupType('CMsgGCCStrike15_v2_ClientCommendPlayer');
const ResponseMsg = protos.cs2.lookupType('CMsgGCCStrike15_v2_ClientReportResponse');

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toLocaleTimeString('tr-TR'); }
function log(msg) { console.log(`  [${ts()}] ${msg}`); }
function ok(msg) { console.log(`  \x1b[32m[${ts()}] ✓ ${msg}\x1b[0m`); }
function fail(msg) { console.log(`  \x1b[31m[${ts()}] ✗ ${msg}\x1b[0m`); }
function info(msg) { console.log(`  \x1b[36m[${ts()}] ℹ ${msg}\x1b[0m`); }
function warn(msg) { console.log(`  \x1b[33m[${ts()}] ⚠ ${msg}\x1b[0m`); }

let proxies = [];
try {
	const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'web', 'proxies.json'), 'utf8'));
	proxies = pd.proxies || [];
} catch {}

async function testRcon() {
	log('RCON bağlantısı test ediliyor...');
	const rcon = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
	try {
		await rcon.connect();
		ok(`RCON bağlandı (${SERVER_IP}:${RCON_PORT})`);
	} catch (err) {
		fail(`RCON BAĞLANTI HATASI: ${err.message}`);
		throw new Error('RCON bağlantısı başarısız — sunucu çalışıyor mu?');
	}

	let serverSteamID;
	try {
		const status = await rcon.execute('status');
		const m = status.match(/steamid\s*:\s*(\d+)/i)
			|| status.match(/\[A:\d+:\d+:\d+\]\s*\((\d+)\)/)
			|| status.match(/(\d{15,})/);
		serverSteamID = m ? m[1] : null;
	} catch (err) {
		fail(`RCON status komutu hatası: ${err.message}`);
		rcon.disconnect();
		throw err;
	}
	rcon.disconnect();

	if (!serverSteamID) {
		fail('Server SteamID alınamadı — status çıktısı parse edilemedi');
		throw new Error('Server SteamID alınamadı');
	}

	const v = validateServerSteamID(serverSteamID);
	if (!v.valid) {
		fail(`Server SteamID geçersiz: ${v.reason}`);
		throw new Error(v.reason);
	}

	ok(`Server SteamID: ${serverSteamID}${v.warning ? ` (${v.warning})` : ''}`);
	return serverSteamID;
}

async function testSingleCommend(account, accountIndex, serverSteamID, proxy) {
	const prefix = `[${account.username}]`;
	const startTime = Date.now();
	const stepTimes = {};

	const steamOpts = { autoRelogin: false };
	if (proxy) {
		steamOpts.httpProxy = proxy;
	}
	const bot = new SteamUser(steamOpts);

	let commendResult = null;

	bot.on('receivedFromGC', (appid, type, body) => {
		if (appid !== APP_ID) return;
		if (type === 4004) {
			try {
				const w = WelcomeMsg.toObject(WelcomeMsg.decode(body), { defaults: true });
				if (w.version && w.version > 0) GC_VERSION = w.version;
			} catch {}
		}
		if (type === 9122) {
			try {
				const r = ResponseMsg.toObject(ResponseMsg.decode(body), { defaults: true, longs: Number });
				commendResult = { tokens: r.tokens };
			} catch {}
		}
	});

	const sendHello = () => {
		const payload = HelloMsg.encode(HelloMsg.create({
			version: GC_VERSION, client_session_need: 1, client_launcher: 0, steam_launcher: 0
		})).finish();
		bot.sendToGC(APP_ID, 4006, {}, Buffer.from(payload));
	};

	try {
		let stepStart = Date.now();
		await new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error('Login timeout (30s)')), 30000);
			bot.logOn({
				accountName: account.username,
				password: account.password,
				twoFactorCode: (account.sharedSecret && account.sharedSecret.length > 5)
					? SteamTotp.getAuthCode(account.sharedSecret) : undefined
			});
			bot.once('loggedOn', () => { clearTimeout(t); resolve(); });
			bot.once('error', (err) => { clearTimeout(t); reject(new Error(`Login: ${err.message}`)); });
		});
		stepTimes.login = Date.now() - stepStart;
		try { await bot.requestFreeLicense(APP_ID); } catch {}
		log(`${prefix} Login OK (${stepTimes.login}ms)${proxy ? ' via proxy' : ''}`);

		stepStart = Date.now();
		bot.gamesPlayed(APP_ID);
		await wait(3000);
		sendHello();

		const gotAccountData = await new Promise((resolve) => {
			const t = setTimeout(() => resolve(false), 10000);
			const h = (appid, type) => {
				if (appid === APP_ID && type === 9110) {
					clearTimeout(t); bot.removeListener('receivedFromGC', h); resolve(true);
				}
			};
			bot.on('receivedFromGC', h);
		});
		stepTimes.gc = Date.now() - stepStart;
		if (gotAccountData) {
			log(`${prefix} GC AccountData OK (${stepTimes.gc}ms)`);
		} else {
			warn(`${prefix} GC AccountData timeout — devam ediliyor (${stepTimes.gc}ms)`);
		}

		stepStart = Date.now();
		const { sessionTicket } = await bot.createAuthSessionTicket(APP_ID);
		const ticketHex = sessionTicket.toString('hex');
		stepTimes.ticket = Date.now() - stepStart;
		log(`${prefix} Auth ticket OK (${ticketHex.length / 2} bytes, ${stepTimes.ticket}ms)`);

		stepStart = Date.now();
		const rcon = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
		await rcon.connect();
		await rcon.execute(`css_auth_end ${bot.steamID.getSteamID64()}`);
		const CHUNK = 400;
		for (let i = 0; i < ticketHex.length; i += CHUNK) {
			await rcon.execute(`css_auth_data ${ticketHex.slice(i, i + CHUNK)}`);
		}
		await rcon.execute(`css_auth_go ${bot.steamID.getSteamID64()}`);
		rcon.disconnect();
		stepTimes.rcon = Date.now() - stepStart;
		log(`${prefix} RCON auth OK (${stepTimes.rcon}ms)`);

		stepStart = Date.now();
		await wait(3000);
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
		stepTimes.bind = Date.now() - stepStart;
		log(`${prefix} Ticket bind OK (${stepTimes.bind}ms)`);

		stepStart = Date.now();
		commendResult = null;

		const commendPayload = CommendMsg.encode(CommendMsg.create({
			account_id: targetAccountId,
			match_id: 0,
			commendation: { cmd_friendly: 1, cmd_teaching: 1, cmd_leader: 1 },
			tokens: 0
		})).finish();

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
		stepTimes.commend = Date.now() - stepStart;

		try {
			const rcon2 = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
			await rcon2.connect();
			await rcon2.execute(`css_auth_end ${bot.steamID.getSteamID64()}`);
			rcon2.disconnect();
		} catch {}

		bot.logOff();

		const totalTime = Date.now() - startTime;

		if (commendResult) {
			ok(`${prefix} COMMEND BAŞARILI — tokens=${commendResult.tokens} (${stepTimes.commend}ms commend, ${totalTime}ms toplam)`);
			return { success: true, tokens: commendResult.tokens, totalTime, stepTimes };
		} else {
			fail(`${prefix} COMMEND TIMEOUT — GC yanıt vermedi (${stepTimes.commend}ms beklendi, ${totalTime}ms toplam)`);
			return { success: false, error: 'timeout', totalTime, stepTimes };
		}

	} catch (err) {
		try { bot.logOff(); } catch {}
		const totalTime = Date.now() - startTime;
		fail(`${prefix} HATA: ${err.message} (${totalTime}ms)`);
		return { success: false, error: err.message, totalTime, stepTimes };
	}
}

async function main() {
	console.log('');
	console.log('  ╔═══════════════════════════════════════════════════════════╗');
	console.log('  ║  CS2 Commend System — End-to-End Validation              ║');
	console.log('  ╚═══════════════════════════════════════════════════════════╝');
	console.log('');
	info(`Hedef: ${TARGET} (accountId: ${targetAccountId})`);
	info(`Gönderilecek commend: ${COUNT}`);
	info(`Hesap aralığı: ${START_INDEX}–${START_INDEX + COUNT - 1}`);
	info(`Proxy havuzu: ${proxies.length} adet`);
	info(`Sunucu: ${SERVER_IP}:${RCON_PORT}`);
	console.log('');

	try {
		GC_VERSION = await fetchGCVersion(null, GC_VERSION);
		ok(`GC Version: ${GC_VERSION}`);
	} catch {
		warn(`GC Version alınamadı, default kullanılıyor: ${GC_VERSION}`);
	}

	console.log('\n  ── Phase 1: RCON Bağlantısı ──');
	let serverSteamID;
	try {
		serverSteamID = await testRcon();
	} catch (err) {
		fail(`RCON testi başarısız: ${err.message}`);
		console.log('\n  ⚠ RCON bağlantısı olmadan devam edilemez.\n');
		process.exit(1);
	}

	console.log(`\n  ── Phase 2: ${COUNT} Commend Gönderimi (Sıralı) ──\n`);

	let successCount = 0;
	let failCount = 0;
	const results = [];

	for (let i = 0; i < COUNT; i++) {
		const accountIndex = START_INDEX + i;
		if (accountIndex >= accounts.length) {
			warn(`Hesap #${accountIndex} yok — havuzda ${accounts.length} hesap var`);
			break;
		}

		const account = accounts[accountIndex];
		const proxy = proxies.length > 0 ? proxies[i % proxies.length] : null;

		console.log(`  ── [${i + 1}/${COUNT}] ${account.username} ──`);
		const result = await testSingleCommend(account, accountIndex, serverSteamID, proxy);
		results.push(result);

		if (result.success) {
			successCount++;
		} else {
			failCount++;
		}
		console.log('');
	}

	console.log('  ═══════════════════════════════════════════════════════════');
	console.log(`  SONUÇ: ${successCount} ✓ başarılı / ${failCount} ✗ başarısız / ${COUNT} toplam`);
	console.log(`  Başarı oranı: %${Math.round(successCount / (successCount + failCount) * 100) || 0}`);

	if (results.some(r => r.success)) {
		const successResults = results.filter(r => r.success);
		const avgTime = Math.round(successResults.reduce((s, r) => s + r.totalTime, 0) / successResults.length);
		const avgCommend = Math.round(successResults.reduce((s, r) => s + (r.stepTimes.commend || 0), 0) / successResults.length);
		console.log(`  Ortalama süre: ${avgTime}ms toplam, ${avgCommend}ms commend yanıtı`);
	}

	if (failCount > 0) {
		console.log('\n  Başarısız olanlar:');
		const byError = {};
		for (const r of results.filter(r => !r.success)) {
			const k = r.error || 'bilinmeyen';
			if (!byError[k]) byError[k] = 0;
			byError[k]++;
		}
		for (const [err, cnt] of Object.entries(byError)) {
			console.log(`    ${err}: ${cnt} adet`);
		}
	}

	if (successCount === COUNT) {
		console.log('\n  ✓ SİSTEM TAM ÇALIŞIYOR — Üretime hazır\n');
	} else if (successCount > 0) {
		console.log('\n  ⚠ Kısmen çalışıyor — hata detaylarını incele\n');
	} else {
		console.log('\n  ✗ SİSTEM ÇALIŞMIYOR — kritik sorun var\n');
	}

	process.exit(failCount > 0 ? 1 : 0);
}

main();
