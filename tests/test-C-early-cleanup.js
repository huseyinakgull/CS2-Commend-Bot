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
const BOTS_PER_METHOD = parseInt(process.argv[3] || '8');
const ACCOUNT_START = parseInt(process.argv[4] || '150');

if (!TARGET) {
	console.log('Kullanım: node tests/test-C-early-cleanup.js <targetSteamID64> [botsPerMethod=8]');
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

async function testBot(accountIndex, serverSteamID, cleanupMode) {
	const account = accounts[accountIndex];
	const proxy = proxies.length > 0 ? proxies[accountIndex % proxies.length] : null;
	const steamOpts = { autoRelogin: false };
	if (proxy) {
		if (proxy.startsWith('socks')) steamOpts.socksProxy = proxy;
		else steamOpts.httpProxy = proxy;
	}

	const bot = new SteamUser(steamOpts);
	let commendResult = null;

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
		await rcon.execute(`css_auth_go ${bot.steamID.getSteamID64()}`);

		if (cleanupMode === 'immediate') {
			await rcon.execute(`css_auth_end ${bot.steamID.getSteamID64()}`);
		}
		rcon.disconnect();

		await wait(3000);
		const activeTickets = bot._activeAuthTickets;
		if (activeTickets) {
			const t = activeTickets.find(t => t.gameid == APP_ID);
			if (t) { t.steamid = serverSteamID; t.estate = 2; }
		}
		bot.gamesPlayed({ game_id: APP_ID, steam_id_gs: serverSteamID });
		await bot._sendAuthList(APP_ID);
		await wait(2000);

		if (cleanupMode === 'early') {
			try {
				const rcon2 = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
				await rcon2.connect();
				await rcon2.execute(`css_auth_end ${bot.steamID.getSteamID64()}`);
				rcon2.disconnect();
			} catch {}
		}

		sendHello();
		await new Promise((resolve) => {
			const t = setTimeout(() => resolve(false), 10000);
			const h = (appid, type) => {
				if (appid === APP_ID && type === 9110) { clearTimeout(t); bot.removeListener('receivedFromGC', h); resolve(true); }
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

		if (cleanupMode === 'late') {
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
			responseMs: elapsed, totalMs: Date.now() - totalStart,
			account: account.username, mode: cleanupMode
		};
	} catch (err) {
		try { bot.logOff(); } catch {}
		return { success: false, error: err.message, account: account.username, mode: cleanupMode, totalMs: Date.now() - totalStart };
	}
}

async function runMethod(label, mode, startIdx, count, serverSteamID) {
	log(`\n${'═'.repeat(60)}`);
	log(`${label} — ${count} bot`);
	log(`${'═'.repeat(60)}`);

	const results = [];
	for (let i = 0; i < count; i++) {
		const idx = startIdx + i;
		const r = await testBot(idx, serverSteamID, mode);
		results.push(r);
		const status = r.success ? `✓ tokens=${r.tokens} ${r.responseMs}ms` : `✗ ${r.error || 'timeout'}`;
		log(`  [${i + 1}/${count}] ${r.account} ${status} (toplam: ${r.totalMs}ms)`);
		await wait(500);
	}
	return results;
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

	const N = BOTS_PER_METHOD;
	const S = ACCOUNT_START;

	const lateResults = await runMethod('MODE A: Geç Cleanup (mevcut)', 'late', S, N, serverSteamID);
	log(`\n⏳ 30s bekleme — rate limit sıfırlansın...`);
	await wait(30000);

	const earlyResults = await runMethod('MODE B: Erken Cleanup (bind sonrası)', 'early', S + N, N, serverSteamID);
	log(`\n⏳ 30s bekleme — rate limit sıfırlansın...`);
	await wait(30000);

	const immediateResults = await runMethod('MODE C: Anında Cleanup (auth_go sonrası)', 'immediate', S + N * 2, N, serverSteamID);

	const lateOK = lateResults.filter(r => r.success).length;
	const earlyOK = earlyResults.filter(r => r.success).length;
	const immediateOK = immediateResults.filter(r => r.success).length;

	log(`\n${'═'.repeat(60)}`);
	log(`SONUÇ — Cleanup Timing Karşılaştırması`);
	log(`${'═'.repeat(60)}`);
	log(`  Mode A (Geç):     ${lateOK}/${N} başarılı`);
	log(`  Mode B (Erken):    ${earlyOK}/${N} başarılı`);
	log(`  Mode C (Anında):   ${immediateOK}/${N} başarılı`);

	if (earlyOK > lateOK) log(`  Erken cleanup daha iyi! Server session saturation doğrulandı.`);
	if (immediateOK > lateOK) log(`  Anında cleanup daha iyi! Server session limiti çok düşük.`);
	if (immediateOK > 0) log(`  Anında cleanup çalışıyor — GC, ticket bind'dan sonra RCON session'a bakmıyor.`);
	if (immediateOK === 0 && earlyOK > 0) log(`  Anında cleanup çok erken — GC ticket doğrulaması için aktif session gerekli.`);

	process.exit(0);
}

main().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
