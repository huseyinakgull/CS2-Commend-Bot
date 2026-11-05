const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const SteamID = require('steamid');
const path = require('path');
const loadProtos = require('./helpers/Protos');
const Rcon = require('./helpers/Rcon');
const { fetchGCVersion } = require('./helpers/ServerValidation');

const config = require('./config.json');
const accounts = require('./accounts.json');
const TARGET = process.argv[2];

if (!TARGET) {
	console.log('Kullanım: node test3-batch1-debug.js <targetSteamID64>');
	process.exit(1);
}

const targetAccountId = new SteamID(TARGET).accountid;
const APP_ID = 730;
let GC_VERSION = 2000771;
const SERVER_IP = config.server.ip;
const RCON_PORT = parseInt(config.server.port || '27015');
const RCON_PASS = config.server.password;

const protos = loadProtos([
	{ name: 'cs2', protos: path.join(__dirname, 'protobufs', 'cs2') },
]);
const HelloMsg = protos.cs2.lookupType('CMsgClientHello');
const CommendMsg = protos.cs2.lookupType('CMsgGCCStrike15_v2_ClientCommendPlayer');
const ResponseMsg = protos.cs2.lookupType('CMsgGCCStrike15_v2_ClientReportResponse');

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg) { console.log(`[${new Date().toLocaleTimeString('tr-TR')}] ${msg}`); }

async function debugBot(accountIndex, serverSteamID) {
	const account = accounts[accountIndex];
	const start = Date.now();
	const elapsed = () => `${Date.now() - start}ms`;

	log(`\n--- Hesap #${accountIndex}: ${account.username} ---`);

	const bot = new SteamUser({ autoRelogin: false });
	let commendResult = null;

	bot.on('receivedFromGC', (appid, type, body) => {
		if (appid !== APP_ID || type !== 9122) return;
		try {
			commendResult = ResponseMsg.toObject(ResponseMsg.decode(body), { defaults: true, longs: Number });
		} catch {}
	});

	log(`  [${elapsed()}] Login başlıyor...`);
	try {
		await new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error('Login timeout (30s)')), 30000);
			bot.logOn({
				accountName: account.username,
				password: account.password,
				twoFactorCode: (account.sharedSecret && account.sharedSecret.length > 5)
					? SteamTotp.getAuthCode(account.sharedSecret) : undefined
			});
			bot.once('loggedOn', () => { clearTimeout(t); resolve(); });
			bot.once('error', (err) => { clearTimeout(t); reject(err); });
		});
		log(`  [${elapsed()}] ✓ Login OK — ${bot.steamID.getSteamID64()}`);
	} catch (e) {
		log(`  [${elapsed()}] ✗ Login FAIL — ${e.message}`);
		return { account: account.username, failAt: 'login', error: e.message };
	}

	try { await bot.requestFreeLicense(APP_ID); } catch {}

	log(`  [${elapsed()}] GC başlatılıyor...`);
	bot.gamesPlayed(APP_ID);
	await wait(3000);

	const sendHello = () => {
		const p = HelloMsg.encode(HelloMsg.create({
			version: GC_VERSION, client_session_need: 1, client_launcher: 0, steam_launcher: 0
		})).finish();
		bot.sendToGC(APP_ID, 4006, {}, Buffer.from(p));
	};
	sendHello();
	const gotData = await new Promise((resolve) => {
		const t = setTimeout(() => resolve(false), 10000);
		const h = (appid, type) => {
			if (appid === APP_ID && type === 9110) { clearTimeout(t); bot.removeListener('receivedFromGC', h); resolve(true); }
		};
		bot.on('receivedFromGC', h);
	});
	log(`  [${elapsed()}] ${gotData ? '✓' : '⚠'} GC AccountData: ${gotData ? 'OK' : 'TIMEOUT'}`);

	log(`  [${elapsed()}] Auth ticket oluşturuluyor...`);
	let sessionTicket;
	try {
		const result = await bot.createAuthSessionTicket(APP_ID);
		sessionTicket = result.sessionTicket;
		log(`  [${elapsed()}] ✓ Auth ticket OK (${sessionTicket.length} bytes)`);
	} catch (e) {
		log(`  [${elapsed()}] ✗ Auth ticket FAIL — ${e.message}`);
		bot.logOff();
		return { account: account.username, failAt: 'auth_ticket', error: e.message };
	}

	log(`  [${elapsed()}] RCON auth başlıyor...`);
	try {
		const rcon = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
		await rcon.connect();
		await rcon.execute(`css_auth_end ${bot.steamID.getSteamID64()}`);

		const ticketHex = sessionTicket.toString('hex');
		const CHUNK = 400;
		for (let i = 0; i < ticketHex.length; i += CHUNK) {
			await rcon.execute(`css_auth_data ${ticketHex.slice(i, i + CHUNK)}`);
		}
		const authResp = await rcon.execute(`css_auth_go ${bot.steamID.getSteamID64()}`);
		rcon.disconnect();

		const isError = authResp.includes('InvalidTicket') || authResp.includes('no_ticket_data') || authResp.includes('AUTH 1');
		if (isError) {
			log(`  [${elapsed()}] ✗ RCON auth FAIL — ${authResp.trim()}`);
			bot.logOff();
			return { account: account.username, failAt: 'rcon_auth', error: authResp.trim() };
		}
		log(`  [${elapsed()}] ✓ RCON auth OK — ${authResp.trim()}`);
	} catch (e) {
		log(`  [${elapsed()}] ✗ RCON bağlantı FAIL — ${e.message}`);
		bot.logOff();
		return { account: account.username, failAt: 'rcon_connect', error: e.message };
	}

	log(`  [${elapsed()}] Server bind...`);
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
	const bindData = await new Promise((resolve) => {
		const t = setTimeout(() => resolve(false), 10000);
		const h = (appid, type) => {
			if (appid === APP_ID && type === 9110) { clearTimeout(t); bot.removeListener('receivedFromGC', h); resolve(true); }
		};
		bot.on('receivedFromGC', h);
	});
	log(`  [${elapsed()}] ${bindData ? '✓' : '⚠'} Bind AccountData: ${bindData ? 'OK' : 'TIMEOUT'}`);
	await wait(1000);

	log(`  [${elapsed()}] Commend gönderiliyor...`);
	const commendPayload = CommendMsg.encode(CommendMsg.create({
		account_id: targetAccountId, match_id: 0,
		commendation: { cmd_friendly: 1, cmd_teaching: 1, cmd_leader: 1 }, tokens: 0
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

	try {
		const rcon2 = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
		await rcon2.connect();
		await rcon2.execute(`css_auth_end ${bot.steamID.getSteamID64()}`);
		rcon2.disconnect();
	} catch {}
	bot.logOff();

	if (commendResult) {
		log(`  [${elapsed()}] ✓ COMMEND OK — tokens=${commendResult.tokens}`);
		return { account: account.username, failAt: null, success: true, tokens: commendResult.tokens, totalMs: Date.now() - start };
	} else {
		log(`  [${elapsed()}] ⏱ COMMEND TIMEOUT`);
		return { account: account.username, failAt: 'commend', error: 'timeout', totalMs: Date.now() - start };
	}
}

async function main() {
	GC_VERSION = await fetchGCVersion(null, GC_VERSION);
	log(`GC Version: ${GC_VERSION}`);
	log(`Target: ${TARGET}`);

	const rcon = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
	await rcon.connect();
	const status = await rcon.execute('status');
	const m = status.match(/steamid\s*:\s*(\d+)/i) || status.match(/(\d{15,})/);
	const serverSteamID = m ? m[1] : null;
	rcon.disconnect();
	log(`Server SteamID: ${serverSteamID}`);

	if (!serverSteamID) {
		log('Server SteamID bulunamadı!');
		process.exit(1);
	}

	const results = [];
	for (let i = 0; i < 20; i++) {
		const result = await debugBot(i, serverSteamID);
		results.push(result);
		await wait(1000);
	}

	log(`\n${'═'.repeat(60)}`);
	log(`ÖZET — İlk 20 hesap:`);
	log(`${'═'.repeat(60)}`);
	log(`${'#'.padEnd(4)} ${'Hesap'.padEnd(18)} ${'Durum'.padEnd(12)} ${'Hata Adımı'.padEnd(15)} Detay`);
	log(`${'-'.repeat(70)}`);

	let successCount = 0;
	const failReasons = {};

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		let status, detail;
		if (r.success) {
			status = '✓ OK';
			detail = `tokens=${r.tokens}, ${r.totalMs}ms`;
			successCount++;
		} else {
			status = '✗ FAIL';
			detail = r.error || '';
			failReasons[r.failAt] = (failReasons[r.failAt] || 0) + 1;
		}
		log(`${String(i).padEnd(4)} ${r.account.padEnd(18)} ${status.padEnd(12)} ${(r.failAt || '-').padEnd(15)} ${detail}`);
	}

	log(`\nBaşarılı: ${successCount}/20`);
	log(`Hata dağılımı:`);
	for (const [step, count] of Object.entries(failReasons)) {
		log(`  ${step}: ${count}`);
	}

	process.exit(0);
}

main().catch(err => {
	log(`FATAL: ${err.message}`);
	process.exit(1);
});
