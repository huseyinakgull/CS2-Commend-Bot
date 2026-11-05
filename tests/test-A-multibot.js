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
const BOT_COUNT = parseInt(process.argv[3] || '20');
const ACCOUNT_START = parseInt(process.argv[4] || '50');

if (!TARGET) {
	console.log('Kullanım: node tests/test-A-multibot.js <targetSteamID64> [botCount=20] [accountStart=50]');
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
const WelcomeMsg = protos.cs2.lookupType('CMsgClientWelcome');
const CommendMsg = protos.cs2.lookupType('CMsgGCCStrike15_v2_ClientCommendPlayer');
const ResponseMsg = protos.cs2.lookupType('CMsgGCCStrike15_v2_ClientReportResponse');

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toLocaleTimeString('tr-TR'); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }

setTimeout(() => { log('Self-destruct (5 dk)'); process.exit(1); }, 300000).unref();

async function main() {
	GC_VERSION = await fetchGCVersion(null, GC_VERSION).catch(() => GC_VERSION);
	log(`Target: ${TARGET} (accountId=${targetAccountId})`);
	log(`Bot count: ${BOT_COUNT}, Account start: ${ACCOUNT_START}`);
	log(`GC Version: ${GC_VERSION}`);
	log(`Proxies: ${proxies.length}`);

	const rcon0 = new Rcon(SERVER_IP, RCON_PORT, RCON_PASS);
	await rcon0.connect();
	const status = await rcon0.execute('status');
	const m = status.match(/steamid\s*:\s*(\d+)/i) || status.match(/(\d{15,})/);
	const serverSteamID = m ? m[1] : null;
	rcon0.disconnect();
	if (!serverSteamID) throw new Error('Server SteamID alınamadı');
	log(`Server SteamID: ${serverSteamID}`);

	log(`\n${'═'.repeat(60)}`);
	log(`ADIM 1: ${BOT_COUNT} bot paralel login`);
	log(`${'═'.repeat(60)}`);

	const bots = [];
	const loginStart = Date.now();

	const loginPromises = [];
	for (let i = 0; i < BOT_COUNT; i++) {
		const idx = ACCOUNT_START + i;
		const account = accounts[idx];
		if (!account) { log(`Hesap #${idx} yok, atlıyorum`); continue; }

		const proxy = proxies.length > 0 ? proxies[i % proxies.length] : null;
		const steamOpts = { autoRelogin: false };
		if (proxy) {
			if (proxy.startsWith('socks')) steamOpts.socksProxy = proxy;
			else steamOpts.httpProxy = proxy;
		}

		loginPromises.push((async () => {
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
						commendResult = r;
					} catch {}
				}
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
				const gotAccountData = await new Promise((resolve) => {
					const t = setTimeout(() => resolve(false), 10000);
					const h = (appid, type) => {
						if (appid === APP_ID && type === 9110) {
							clearTimeout(t); bot.removeListener('receivedFromGC', h); resolve(true);
						}
					};
					bot.on('receivedFromGC', h);
				});

				return {
					bot, account, idx, commendResult: () => commendResult,
					resetResult: () => { commendResult = null; },
					sendHello, ready: true, gotAccountData
				};
			} catch (err) {
				try { bot.logOff(); } catch {}
				return { bot: null, account, idx, ready: false, error: err.message };
			}
		})());
	}

	const results = await Promise.all(loginPromises);
	const readyBots = results.filter(r => r.ready);
	const failedBots = results.filter(r => !r.ready);

	log(`Login tamamlandı: ${readyBots.length}✓ ${failedBots.length}✗ — ${((Date.now() - loginStart) / 1000).toFixed(1)}s`);
	if (failedBots.length > 0) {
		log(`  Başarısız: ${failedBots.map(b => `${b.account.username}(${b.error})`).join(', ')}`);
	}

	if (readyBots.length === 0) {
		log('Hiç bot login olamadı, çıkılıyor');
		process.exit(1);
	}

	log(`\n${'═'.repeat(60)}`);
	log(`ADIM 2: ${readyBots.length} bot sırayla RCON auth + bind`);
	log(`${'═'.repeat(60)}`);

	const authedBots = [];
	const authStart = Date.now();

	for (const entry of readyBots) {
		const { bot, account, sendHello } = entry;
		try {
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
			rcon.disconnect();

			await wait(2000);
			const activeTickets = bot._activeAuthTickets;
			let bound = false;
			if (activeTickets) {
				const t = activeTickets.find(t => t.gameid == APP_ID);
				if (t) { t.steamid = serverSteamID; t.estate = 2; bound = true; }
			}
			if (!bound) {
				log(`  ${account.username} ⚠ ticket bind başarısız — atlanıyor`);
				continue;
			}

			bot.gamesPlayed({ game_id: APP_ID, steam_id_gs: serverSteamID });
			await bot._sendAuthList(APP_ID);
			await wait(1000);

			sendHello();
			await new Promise((resolve) => {
				const t = setTimeout(() => resolve(false), 8000);
				const h = (appid, type) => {
					if (appid === APP_ID && type === 9110) {
						clearTimeout(t); bot.removeListener('receivedFromGC', h); resolve(true);
					}
				};
				bot.on('receivedFromGC', h);
			});

			authedBots.push(entry);
			log(`  [${authedBots.length}/${readyBots.length}] ${account.username} ✓ auth OK`);
		} catch (err) {
			log(`  ${account.username} ✗ auth hatası: ${err.message}`);
		}
	}

	log(`Auth tamamlandı: ${authedBots.length} bot hazır — ${((Date.now() - authStart) / 1000).toFixed(1)}s`);

	if (authedBots.length === 0) {
		log('Hiç bot auth olamadı, çıkılıyor');
		readyBots.forEach(b => { try { b.bot.logOff(); } catch {} });
		process.exit(1);
	}

	log(`\n${'═'.repeat(60)}`);
	log(`ADIM 3: ${authedBots.length} bottan hızlı commend — 2s aralıkla`);
	log(`${'═'.repeat(60)}`);

	const commendPayload = CommendMsg.encode(CommendMsg.create({
		account_id: targetAccountId, match_id: 0,
		commendation: { cmd_friendly: 1, cmd_teaching: 1, cmd_leader: 1 }, tokens: 0
	})).finish();

	let success = 0, fail = 0;
	const commendStart = Date.now();

	for (let i = 0; i < authedBots.length; i++) {
		const entry = authedBots[i];
		entry.resetResult();

		const sendTime = Date.now();
		entry.bot.sendToGC(APP_ID, 9121, {}, Buffer.from(commendPayload));

		for (let w = 0; w < 16; w++) {
			await wait(500);
			if (entry.commendResult()) break;
		}

		const result = entry.commendResult();
		const elapsed = Date.now() - sendTime;
		if (result) {
			success++;
			log(`  [${i + 1}/${authedBots.length}] ${entry.account.username} ✓ tokens=${result.tokens} (${elapsed}ms)`);
		} else {
			fail++;
			log(`  [${i + 1}/${authedBots.length}] ${entry.account.username} ✗ timeout (${elapsed}ms)`);
		}

		if (i < authedBots.length - 1) await wait(2000);
	}

	const totalTime = ((Date.now() - commendStart) / 1000).toFixed(1);

	log(`\n${'═'.repeat(60)}`);
	log(`SONUÇ — Test A: Multi-Bot Tek Process`);
	log(`${'═'.repeat(60)}`);
	log(`  Başarılı: ${success}/${authedBots.length}`);
	log(`  Başarısız: ${fail}/${authedBots.length}`);
	log(`  Commend süresi: ${totalTime}s (ort: ${(parseFloat(totalTime) / authedBots.length).toFixed(1)}s/commend)`);
	log(`  Login süresi: ${((Date.now() - loginStart) / 1000).toFixed(1)}s`);

	for (const entry of readyBots) {
		try { entry.bot.logOff(); } catch {}
	}
	setTimeout(() => process.exit(0), 3000);
}

main().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
