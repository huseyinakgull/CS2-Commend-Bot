const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const SteamID = require('steamid');
const path = require('path');
const fs = require('fs');
const loadProtos = require('../helpers/Protos');
const Rcon = require('../helpers/Rcon');
const { validateServerSteamID, fetchGCVersion } = require('../helpers/ServerValidation');

const config = require('../config.json');
const accounts = require('../accounts.json');
const proxiesData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'web', 'proxies.json'), 'utf8'));
const proxies = proxiesData.proxies || [];

const TARGET = process.argv[2];
const COMMEND_COUNT = parseInt(process.argv[3] || '300');
const ACCOUNT_START = parseInt(process.argv[4] || '0');

if (!TARGET) {
	console.log('Kullanım: node tests/test-pool-300.js <targetSteamID64> [commendCount=300] [accountStart=0]');
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
const HelloMsg    = protos.cs2.lookupType('CMsgClientHello');
const WelcomeMsg  = protos.cs2.lookupType('CMsgClientWelcome');
const CommendMsg  = protos.cs2.lookupType('CMsgGCCStrike15_v2_ClientCommendPlayer');
const ResponseMsg = protos.cs2.lookupType('CMsgGCCStrike15_v2_ClientReportResponse');

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toLocaleTimeString('tr-TR'); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }

const LOGIN_BATCH_SIZE = 100;
const LOGIN_TIMEOUT    = 3000;
const GC_HELLO_TIMEOUT = 1000;
const AUTH_BIND_WAIT   = 250;
const AUTH_LIST_WAIT   = 150;
const HELLO2_TIMEOUT   = 800;
const COMMEND_WAIT     = 8500;
const COMMEND_RETRY_WAIT = 3500;
const INTER_COMMEND_MS = 1500;

function createBot(account, proxyUrl) {
	const steamOpts = { autoRelogin: false };
	if (proxyUrl) {
		if (proxyUrl.startsWith('socks')) steamOpts.socksProxy = proxyUrl;
		else steamOpts.httpProxy = proxyUrl;
	}

	const bot = new SteamUser(steamOpts);
	let _commendResult = null;

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
				_commendResult = r;
			} catch {}
		}
	});

	return {
		bot,
		account,
		proxy: proxyUrl,
		getResult: () => _commendResult,
		resetResult: () => { _commendResult = null; },
		sendHello: () => {
			const p = HelloMsg.encode(HelloMsg.create({
				version: GC_VERSION, client_session_need: 1, client_launcher: 0, steam_launcher: 0
			})).finish();
			bot.sendToGC(APP_ID, 4006, {}, Buffer.from(p));
		},
		waitForGC: (msgType, timeoutMs) => new Promise(resolve => {
			const t = setTimeout(() => resolve(false), timeoutMs);
			const h = (appid, type) => {
				if (appid === APP_ID && type === msgType) {
					clearTimeout(t); bot.removeListener('receivedFromGC', h); resolve(true);
				}
			};
			bot.on('receivedFromGC', h);
		})
	};
}

async function loginBatch(accountIndices) {
	const entries = [];

	const promises = accountIndices.map(idx => {
		const account = accounts[idx];
		if (!account) return Promise.resolve(null);
		const proxy = proxies.length > 0 ? proxies[idx % proxies.length] : null;
		const entry = createBot(account, proxy);

		return (async () => {
			try {
				await new Promise((resolve, reject) => {
					const t = setTimeout(() => reject(new Error('Login timeout')), LOGIN_TIMEOUT);
					entry.bot.logOn({
						accountName: account.username,
						password: account.password,
						twoFactorCode: (account.sharedSecret && account.sharedSecret.length > 5)
							? SteamTotp.getAuthCode(account.sharedSecret) : undefined
					});
					entry.bot.once('loggedOn', () => { clearTimeout(t); resolve(); });
					entry.bot.once('error', (err) => { clearTimeout(t); reject(err); });
				});
				try { await entry.bot.requestFreeLicense(APP_ID); } catch {}

				entry.bot.gamesPlayed(APP_ID);
				await wait(3000);
				entry.sendHello();
				await entry.waitForGC(9110, GC_HELLO_TIMEOUT);

				return { ...entry, idx, ready: true };
			} catch (err) {
				try { entry.bot.logOff(); } catch {}
				return { ...entry, idx, ready: false, error: err.message };
			}
		})();
	});

	const results = await Promise.all(promises);
	return results.filter(Boolean);
}

async function authBot(entry, serverSteamID) {
	const { bot, account } = entry;
	const u = account.username;
	try {
		log(`    [auth] ${u} — ticket alınıyor`);
		const { sessionTicket } = await bot.createAuthSessionTicket(APP_ID);
		const ticketHex = sessionTicket.toString('hex');

		log(`    [auth] ${u} — RCON`);
		const rcon = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
		await rcon.connect();
		await rcon.execute(`css_auth_end ${bot.steamID.getSteamID64()}`);
		const CHUNK = 400;
		for (let i = 0; i < ticketHex.length; i += CHUNK) {
			await rcon.execute(`css_auth_data ${ticketHex.slice(i, i + CHUNK)}`);
		}
		await rcon.execute(`css_auth_go ${bot.steamID.getSteamID64()}`);
		rcon.disconnect();

		log(`    [auth] ${u} — bind bekleniyor`);
		await wait(AUTH_BIND_WAIT);
		const activeTickets = bot._activeAuthTickets;
		let bound = false;
		if (activeTickets) {
			const t = activeTickets.find(t => t.gameid == APP_ID);
			if (t) { t.steamid = serverSteamID; t.estate = 2; bound = true; }
		}
		if (!bound) throw new Error('Ticket bind başarısız');

		log(`    [auth] ${u} — gamesPlayed + authList`);
		bot.gamesPlayed({ game_id: APP_ID, steam_id_gs: serverSteamID });
		await bot._sendAuthList(APP_ID);
		await wait(AUTH_LIST_WAIT);

		log(`    [auth] ${u} — hello2 gönderiliyor`);
		entry.sendHello();
		await entry.waitForGC(9110, HELLO2_TIMEOUT);
		log(`    [auth] ${u} — OK`);

		return true;
	} catch (err) {
		entry.authError = err.message;
		return false;
	}
}

async function authBotSafe(entry, serverSteamID) {
	const TIMEOUT = AUTH_BIND_WAIT + AUTH_LIST_WAIT + HELLO2_TIMEOUT + 15000;
	return Promise.race([
		authBot(entry, serverSteamID),
		new Promise(resolve => setTimeout(() => {
			entry.authError = `auth timeout (${TIMEOUT}ms)`;
			resolve(false);
		}, TIMEOUT))
	]);
}

async function sendCommend(entry) {
	entry.resetResult();

	const commendPayload = CommendMsg.encode(CommendMsg.create({
		account_id: targetAccountId, match_id: 0,
		commendation: { cmd_friendly: 1, cmd_teaching: 1, cmd_leader: 1 }, tokens: 0
	})).finish();

	const sendTime = Date.now();
	entry.bot.sendToGC(APP_ID, 9121, {}, Buffer.from(commendPayload));

	const deadline = sendTime + COMMEND_WAIT;
	while (Date.now() < deadline) {
		await wait(250);
		if (entry.getResult()) break;
	}

	if (!entry.getResult()) {
		entry.bot.sendToGC(APP_ID, 9121, {}, Buffer.from(commendPayload));
		const deadline2 = Date.now() + COMMEND_RETRY_WAIT;
		while (Date.now() < deadline2) {
			await wait(250);
			if (entry.getResult()) break;
		}
	}

	const elapsed = Date.now() - sendTime;
	const result = entry.getResult();
	return { success: !!result, tokens: result ? result.tokens : null, elapsed };
}

async function cleanupBot(entry) {
	try {
		const rcon = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
		await rcon.connect();
		await rcon.execute(`css_auth_end ${entry.bot.steamID.getSteamID64()}`);
		rcon.disconnect();
	} catch {}
	try { entry.bot.logOff(); } catch {}
}

async function main() {
	GC_VERSION = await fetchGCVersion(null, GC_VERSION).catch(() => GC_VERSION);
	log(`Target: ${TARGET} (accountId=${targetAccountId})`);
	log(`Commend hedefi: ${COMMEND_COUNT}`);
	log(`GC Version: ${GC_VERSION}`);
	log(`Hesaplar: ${accounts.length} (start: ${ACCOUNT_START})`);
	log(`Proxy: ${proxies.length}`);

	const rcon0 = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
	await rcon0.connect();
	const status = await rcon0.execute('status');
	const m = status.match(/steamid\s*:\s*(\d+)/i) || status.match(/(\d{15,})/);
	const serverSteamID = m ? m[1] : null;
	rcon0.disconnect();
	if (!serverSteamID) throw new Error('Server SteamID alınamadı');
	log(`Server SteamID: ${serverSteamID}`);

	const overallStart = Date.now();
	let totalSuccess = 0;
	let totalFail = 0;
	let totalSkipped = 0;
	let accountIdx = ACCOUNT_START;
	let consecutiveTimeouts = 0;
	const MAX_CONSECUTIVE_TIMEOUTS = 10;

	while (totalSuccess < COMMEND_COUNT) {
		const remaining = COMMEND_COUNT - totalSuccess;
		const batchSize = Math.min(LOGIN_BATCH_SIZE, remaining, accounts.length - accountIdx);

		if (batchSize <= 0) {
			log(`Hesap havuzu tükendi (index: ${accountIdx}/${accounts.length})`);
			break;
		}

		const batchNum = Math.floor((accountIdx - ACCOUNT_START) / LOGIN_BATCH_SIZE) + 1;
		log(`\n${'─'.repeat(60)}`);
		log(`BATCH ${batchNum} — ${batchSize} bot login (hesap #${accountIdx}-${accountIdx + batchSize - 1})`);
		log(`İlerleme: ${totalSuccess}/${COMMEND_COUNT} ✓ | ${totalFail} ✗ | ${remaining} kalan`);
		log(`${'─'.repeat(60)}`);

		const indices = [];
		for (let i = 0; i < batchSize; i++) indices.push(accountIdx + i);
		accountIdx += batchSize;

		const loginStart = Date.now();
		const entries = await loginBatch(indices);
		const readyEntries = entries.filter(e => e.ready);
		const failedLogins = entries.filter(e => !e.ready);
		totalSkipped += failedLogins.length;

		log(`  Login: ${readyEntries.length}✓ ${failedLogins.length}✗ — ${((Date.now() - loginStart) / 1000).toFixed(1)}s`);

		if (readyEntries.length === 0) {
			log(`  Bu batch'te login olan bot yok, sonraki batch'e geçiliyor`);
			continue;
		}

		log(`  Auth fazı: ${readyEntries.length} bot...`);
		const authedEntries = [];
		for (const entry of readyEntries) {
			const authOk = await authBotSafe(entry, serverSteamID);
			if (!authOk) {
				log(`  auth ✗ ${entry.account.username}: ${entry.authError}`);
				totalFail++;
				try { entry.bot.logOff(); } catch {}
			} else {
				authedEntries.push(entry);
			}
		}
		log(`  Auth tamamlandı: ${authedEntries.length}✓ ${readyEntries.length - authedEntries.length}✗`);

		for (let i = 0; i < authedEntries.length; i++) {
			if (totalSuccess >= COMMEND_COUNT) break;
			if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
				log(`  ${MAX_CONSECUTIVE_TIMEOUTS} ardışık timeout — 60s bekleniyor`);
				await wait(60000);
				consecutiveTimeouts = 0;
			}

			const entry = authedEntries[i];

			const result = await sendCommend(entry);
			const n = totalSuccess + totalFail + 1;

			if (result.success) {
				totalSuccess++;
				consecutiveTimeouts = 0;
				log(`  [${totalSuccess}/${COMMEND_COUNT}] ${entry.account.username} ✓ tokens=${result.tokens} (${result.elapsed}ms)`);
			} else {
				totalFail++;
				consecutiveTimeouts++;
				log(`  [${n}] ${entry.account.username} ✗ timeout (${result.elapsed}ms) — ardışık: ${consecutiveTimeouts}`);
			}

			cleanupBot(entry);

			if (i < authedEntries.length - 1 && totalSuccess < COMMEND_COUNT) {
				await wait(INTER_COMMEND_MS);
			}

			if (totalSuccess > 0 && totalSuccess % 25 === 0) {
				const elapsed = (Date.now() - overallStart) / 1000;
				const rate = totalSuccess / elapsed * 60;
				const eta = (COMMEND_COUNT - totalSuccess) / (rate / 60);
				log(`\n  ── DURUM: ${totalSuccess}/${COMMEND_COUNT} ✓ | ${totalFail} ✗ | hız: ${rate.toFixed(1)}/dk | ETA: ${(eta / 60).toFixed(1)} dk ──\n`);
			}
		}

		for (const entry of readyEntries) {
			try { entry.bot.logOff(); } catch {}
		}
	}

	const totalTime = (Date.now() - overallStart) / 1000;
	const rate = totalSuccess / totalTime * 60;

	log(`\n${'═'.repeat(60)}`);
	log(`SONUÇ — Pool Mimarisi ${COMMEND_COUNT} Commend Testi`);
	log(`${'═'.repeat(60)}`);
	log(`  Başarılı:    ${totalSuccess}/${COMMEND_COUNT}`);
	log(`  Başarısız:   ${totalFail}`);
	log(`  Login skip:  ${totalSkipped}`);
	log(`  Toplam süre: ${(totalTime / 60).toFixed(1)} dakika`);
	log(`  Hız:         ${rate.toFixed(1)} commend/dakika`);
	log(`  Ort/commend: ${(totalTime / Math.max(1, totalSuccess)).toFixed(1)}s`);

	process.exit(0);
}

main().catch(err => {
	log(`FATAL: ${err.message}`);
	console.error(err);
	process.exit(1);
});
