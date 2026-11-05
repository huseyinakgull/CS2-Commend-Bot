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

if (!TARGET) {
	console.log('Kullanım: node test2-rate-limit.js <targetSteamID64>');
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

let serverSteamID = null;

async function getServerSteamID() {
	if (serverSteamID) return serverSteamID;
	const rcon = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
	await rcon.connect();
	const status = await rcon.execute('status');
	const m = status.match(/steamid\s*:\s*(\d+)/i) || status.match(/(\d{15,})/);
	serverSteamID = m ? m[1] : null;
	rcon.disconnect();
	return serverSteamID;
}

async function sendSingleCommend(accountIndex) {
	const account = accounts[accountIndex];
	const bot = new SteamUser({ autoRelogin: false });
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
				accountName: account.username,
				password: account.password,
				twoFactorCode: (account.sharedSecret && account.sharedSecret.length > 5)
					? SteamTotp.getAuthCode(account.sharedSecret) : undefined
			});
			bot.once('loggedOn', () => { clearTimeout(t); resolve(); });
			bot.once('error', (err) => { clearTimeout(t); reject(err); });
		});
	} catch (e) {
		return { success: false, error: `login: ${e.message}`, account: account.username };
	}

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

	try {
		const rcon = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
		await rcon.connect();
		await rcon.execute(`css_auth_end ${bot.steamID.getSteamID64()}`);
		const CHUNK = 400;
		for (let i = 0; i < ticketHex.length; i += CHUNK) {
			await rcon.execute(`css_auth_data ${ticketHex.slice(i, i + CHUNK)}`);
		}
		await rcon.execute(`css_auth_go ${bot.steamID.getSteamID64()}`);
		rcon.disconnect();
	} catch (e) {
		bot.logOff();
		return { success: false, error: `rcon: ${e.message}`, account: account.username };
	}

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

	const responseTime = commendResult ? Date.now() - sendTime : null;

	try {
		const rcon2 = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
		await rcon2.connect();
		await rcon2.execute(`css_auth_end ${bot.steamID.getSteamID64()}`);
		rcon2.disconnect();
	} catch {}
	bot.logOff();

	if (commendResult) {
		return { success: true, tokens: commendResult.tokens, responseMs: responseTime, account: account.username };
	} else {
		return { success: false, error: 'timeout', account: account.username };
	}
}

async function main() {
	GC_VERSION = await fetchGCVersion(null, GC_VERSION);
	log(`GC Version: ${GC_VERSION}`);
	log(`Target: ${TARGET} (accountId=${targetAccountId})`);

	serverSteamID = await getServerSteamID();
	log(`Server SteamID: ${serverSteamID}`);

	log(`\n${'═'.repeat(60)}`);
	log(`PHASE 1: Sıralı commend — rate limit sınırını bulma`);
	log(`${'═'.repeat(60)}`);

	let successCount = 0;
	let consecutiveTimeouts = 0;
	let rateLimitHitAt = null;
	let accountIndex = 10;

	for (let i = 0; i < 40; i++) {
		const n = i + 1;
		log(`\n--- Commend #${n} (hesap index: ${accountIndex}) ---`);
		const result = await sendSingleCommend(accountIndex);
		accountIndex++;

		if (result.error === 'login: Login timeout' || result.error?.startsWith('login:') || result.error?.startsWith('rcon:')) {
			log(`  #${n}: ✗ HATA — ${result.error} (${result.account})`);
			consecutiveTimeouts = 0;
			continue;
		}

		if (result.success) {
			successCount++;
			consecutiveTimeouts = 0;
			log(`  #${n}: ✓ OK — tokens=${result.tokens}, ${result.responseMs}ms (${result.account})`);
		} else {
			consecutiveTimeouts++;
			log(`  #${n}: ⏱ TIMEOUT (${result.account}) — ardışık timeout: ${consecutiveTimeouts}`);

			if (consecutiveTimeouts >= 3) {
				rateLimitHitAt = successCount;
				log(`\nRATE LIMIT: ${successCount} başarılı commend sonra GC yanıt vermeyi bıraktı`);
				break;
			}
		}

		await wait(1000);
	}

	if (!rateLimitHitAt) {
		log(`\n40 commend denendi, rate limit'e ulaşılmadı. ${successCount} başarılı.`);
		process.exit(0);
	}

	const cooldowns = [60, 120, 300];

	for (const cooldownSec of cooldowns) {
		log(`\n${'═'.repeat(60)}`);
		log(`PHASE 2: ${cooldownSec}s cooldown sonrası test (${cooldownSec / 60} dakika)`);
		log(`${'═'.repeat(60)}`);
		log(`Bekleniyor...`);

		for (let remaining = cooldownSec; remaining > 0; remaining -= 10) {
			await wait(10000);
			if (remaining % 30 === 0) log(`  ${remaining}s kaldı...`);
		}

		log(`Cooldown bitti, 3 commend deneniyor...`);

		let cooldownSuccess = 0;
		for (let j = 0; j < 3; j++) {
			log(`\n--- Cooldown test #${j + 1} (hesap index: ${accountIndex}) ---`);
			const result = await sendSingleCommend(accountIndex);
			accountIndex++;

			if (result.success) {
				cooldownSuccess++;
				log(`  ✓ OK — tokens=${result.tokens}, ${result.responseMs}ms`);
			} else if (result.error === 'timeout') {
				log(`  ⏱ TIMEOUT — rate limit hala aktif`);
			} else {
				log(`  ✗ HATA — ${result.error}`);
			}
			await wait(1000);
		}

		log(`\n${cooldownSec}s cooldown sonucu: ${cooldownSuccess}/3 başarılı`);

		if (cooldownSuccess > 0) {
			log(`Rate limit ${cooldownSec}s sonra sıfırlandı!`);
			break;
		} else {
			log(`Rate limit ${cooldownSec}s sonra hala aktif.`);
		}
	}

	log(`\n${'═'.repeat(60)}`);
	log(`ÖZET:`);
	log(`${'═'.repeat(60)}`);
	log(`  Rate limit sınırı: ~${rateLimitHitAt} commend/sunucu`);
	log(`  Server SteamID: ${serverSteamID}`);

	process.exit(0);
}

main().catch(err => {
	log(`FATAL: ${err.message}`);
	process.exit(1);
});
