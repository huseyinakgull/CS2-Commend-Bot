// Sends one commend from one bot account, in its own process, so a stuck Steam or
// GC connection can be killed without affecting the rest of the pool.
// Spawned by web/bot-manager.js, which reads the single "__RESULT__{json}" line
// printed on exit.
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const SteamID = require('steamid');
const path = require('path');
const fs = require('fs');
const loadProtos = require('./helpers/Protos');
const Rcon = require('./helpers/Rcon');

const config = require('./config.json');
const accounts = require('./accounts.json');

const TARGET = process.argv[2];
const ACCOUNT_INDEX = parseInt(process.argv[3] || '0');
const PRE_SERVER_STEAM_ID = process.argv[4] || null;

if (!TARGET) {
	console.log('Kullanım: node commend-single.js <targetSteamID64> <accountIndex> [serverSteamID]');
	process.exit(1);
}

const account = accounts[ACCOUNT_INDEX];
if (!account) {
	console.log('__RESULT__' + JSON.stringify({ success: false, error: `Account index ${ACCOUNT_INDEX} not found` }));
	process.exit(1);
}

const { validateServerSteamID, fetchGCVersion } = require('./helpers/ServerValidation');
const PROXY = process.env.COMMEND_PROXY || null;

const SERVER_IP    = config.server.ip;
const RCON_IP      = config.server.rconIp || config.server.ip;
const RCON_PORT    = parseInt(config.server.port || '27015');
const RCON_PASS    = config.server.password;
const APP_ID       = 730;
let   GC_VERSION   = 2000771;

const targetAccountId = new SteamID(TARGET).accountid;

const protos = loadProtos([
	{ name: 'cs2', protos: path.join(__dirname, 'protobufs', 'cs2') },
]);
const HelloMsg    = protos.cs2.lookupType('CMsgClientHello');
const WelcomeMsg  = protos.cs2.lookupType('CMsgClientWelcome');
const AccDataResp = protos.cs2.lookupType('CMsgGCCStrike15_v2_MatchmakingGC2ClientHello');
const CommendMsg  = protos.cs2.lookupType('CMsgGCCStrike15_v2_ClientCommendPlayer');
const ResponseMsg = protos.cs2.lookupType('CMsgGCCStrike15_v2_ClientReportResponse');

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg) { console.log(`[${new Date().toLocaleTimeString('tr-TR')}] ${msg}`); }

const LOCK_FILE = path.join(__dirname, '.rcon.lock');

let _heldLock = false;

function _cleanupLockIfMine() {
	if (!_heldLock) return;
	try {
		const owner = fs.readFileSync(LOCK_FILE, 'utf8').trim();
		if (owner === String(process.pid)) {
			fs.unlinkSync(LOCK_FILE);
		}
	} catch {}
	_heldLock = false;
}

process.on('SIGTERM', () => { _cleanupLockIfMine(); process.exit(143); });
process.on('SIGINT',  () => { _cleanupLockIfMine(); process.exit(130); });
process.on('SIGHUP',  () => { _cleanupLockIfMine(); process.exit(129); });
process.on('exit',    () => { _cleanupLockIfMine(); });
process.on('uncaughtException', (err) => {
	_cleanupLockIfMine();
	try { console.error('uncaughtException:', err && err.stack || err); } catch {}
	process.exit(1);
});

// The server plugin buffers one auth ticket at a time, so ticket uploads from
// parallel child processes are serialised with a lock file. A lock older than
// 30 seconds is treated as abandoned.
async function withRconLock(fn) {
	const maxWait = 30000;
	const start = Date.now();
	let acquired = false;
	while (Date.now() - start < maxWait) {
		try {
			fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
			_heldLock = true;
			acquired = true;
			break;
		} catch {
			try {
				const stat = fs.statSync(LOCK_FILE);
				if (Date.now() - stat.mtimeMs > 30000) {
					fs.unlinkSync(LOCK_FILE);
				}
			} catch {}
			await wait(200 + Math.random() * 300);
		}
	}
	if (!acquired) {
		throw new Error('RCON lock timeout — başka process kilidi bırakmamış olabilir');
	}
	try {
		return await fn();
	} finally {
		_cleanupLockIfMine();
	}
}

setTimeout(() => {
	console.log('__RESULT__' + JSON.stringify({ success: false, account: account.username, error: 'Process self-destruct (90s)' }));
	process.exit(1);
}, 90000).unref();

const _gcVersionReady = fetchGCVersion(null, GC_VERSION).then(v => { GC_VERSION = v; }).catch(() => {});

const steamOpts = { autoRelogin: false };
if (PROXY) {
	if (PROXY.startsWith('socks')) {
		steamOpts.socksProxy = PROXY;
	} else {
		steamOpts.httpProxy = PROXY;
	}
}
const bot = new SteamUser(steamOpts);

let commendResult = null;

let _authSlotActive = false;
let _myBotSteamID64 = null;

bot.on('receivedFromGC', (appid, type, body) => {
	if (appid !== APP_ID) return;
	const names = {
		4004: 'Welcome', 4009: 'ConnStatus', 9110: 'AccountData',
		9122: 'COMMEND_RESPONSE', 9173: 'GlobalStats', 9187: 'FatalError',
		9128: 'PlayerProfile', 9194: 'RankUpdate'
	};

	if (type === 4004) {
		try {
			const w = WelcomeMsg.toObject(WelcomeMsg.decode(body), { defaults: true });
			if (w.version && w.version > 0 && w.version !== GC_VERSION) {
				log(`  GC VERSION: ${GC_VERSION} -> ${w.version}`);
				GC_VERSION = w.version;
			}
		} catch {}
	}
	// ClientReportResponse. The result codes below are the ones seen in practice;
	// anything else is reported as failed_<code>.
	if (type === 9122) {
		try {
			const r = ResponseMsg.toObject(ResponseMsg.decode(body), { defaults: true, longs: Number });
			const result = r.response_result;
			let category = 'unknown';
			let accepted = false;
			if (result === 1) { accepted = true; category = 'success'; }
			else if (result === undefined) { accepted = true; category = 'ack_no_result'; }
			else if (result === 2 || result === 6) category = 'target_not_found';
			else if (result === 8 || result === 9) category = 'already_commended';
			else if (result === 10 || result === 11 || result === 15) category = 'rate_limited';
			else category = 'failed_' + result;

			commendResult = {
				tokens: r.tokens,
				response_type: r.response_type,
				response_result: result,
				account_id: r.account_id,
				confirmation_id: r.confirmation_id,
				accepted,
				category
			};
			console.log(`__GC_RESPONSE__${JSON.stringify({
				result,
				category,
				tokens: r.tokens,
				accepted
			})}`);
		} catch (e) {
			console.log(`__GC_RESPONSE_PARSE_ERR__${e.message}`);
		}
	}
});

async function run() {
	await _gcVersionReady;
	const prefix = `[${account.username}]`;

	await new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('Login timeout (30s)')), 30000);
		bot.logOn({
			accountName: account.username,
			password: account.password,
			twoFactorCode: (account.sharedSecret && account.sharedSecret.length > 5)
				? SteamTotp.getAuthCode(account.sharedSecret) : undefined
		});
		bot.once('loggedOn', () => { clearTimeout(t); resolve(); });
		bot.once('error', (err) => {
			clearTimeout(t);
			const e = new Error(`Steam login error: ${err.message}`);
			e.eresult = err.eresult;
			reject(e);
		});
	});
	try { await bot.requestFreeLicense(APP_ID); } catch {}
	log(`${prefix} Login OK`);

	bot.gamesPlayed(APP_ID);
	await wait(3000);

	const sendHello = () => {
		const payload = HelloMsg.encode(HelloMsg.create({
			version: GC_VERSION, client_session_need: 1, client_launcher: 0, steam_launcher: 0
		})).finish();
		bot.sendToGC(APP_ID, 4006, {}, Buffer.from(payload));
	};

	sendHello();
	await new Promise((resolve) => {
		const t = setTimeout(() => resolve(false), 10000);
		const h = (appid, type) => {
			if (appid === APP_ID && type === 9110) { clearTimeout(t); bot.removeListener('receivedFromGC', h); resolve(true); }
		};
		bot.on('receivedFromGC', h);
	});

	let sessionTicket;
	try {
		const ticketResult = await bot.createAuthSessionTicket(APP_ID);
		sessionTicket = ticketResult.sessionTicket;
	} catch (err) {
		throw new Error(`Auth ticket oluşturulamadı: ${err.message}`);
	}
	const ticketHex = sessionTicket.toString('hex');

	let serverSteamID = PRE_SERVER_STEAM_ID;

	// Hand the ticket to the CommendBotAuth plugin, which calls BeginAuthSession on
	// the server. The ticket is sent in chunks because RCON commands have a length limit.
	await withRconLock(async () => {
		const rcon = new Rcon(RCON_IP, RCON_PORT, RCON_PASS);
		try {
			await rcon.connect();
		} catch (err) {
			throw new Error(`RCON bağlantı hatası (${RCON_IP}:${RCON_PORT}): ${err.message}`);
		}

		await rcon.execute(`css_auth_end ${bot.steamID.getSteamID64()}`);

		const CHUNK = 400;
		for (let i = 0; i < ticketHex.length; i += CHUNK) {
			await rcon.execute(`css_auth_data ${ticketHex.slice(i, i + CHUNK)}`);
		}
		await rcon.execute(`css_auth_go ${bot.steamID.getSteamID64()}`);
		_authSlotActive = true;
		_myBotSteamID64 = bot.steamID.getSteamID64();

		if (!serverSteamID) {
			const status = await rcon.execute('status');
			const m = status.match(/steamid\s*:\s*(\d+)/i)
				|| status.match(/\[A:\d+:\d+:\d+\]\s*\((\d+)\)/)
				|| status.match(/(\d{15,})/);
			serverSteamID = m ? m[1] : null;
		}
		rcon.disconnect();
	});

	if (!serverSteamID) throw new Error('Server SteamID alınamadı');

	const validation = validateServerSteamID(serverSteamID);
	if (!validation.valid) {
		throw new Error(validation.reason);
	}

	// steam-user has no public API for binding a ticket to a game server, so the
	// internal ticket list is updated and re-sent. Without this the GC does not see
	// the bot as playing on the server and ignores the commend.
	await wait(3000);
	const activeTickets = bot._activeAuthTickets;
	let ticketBound = false;
	if (activeTickets) {
		const t = activeTickets.find(t => t.gameid == APP_ID);
		if (t) {
			t.steamid = serverSteamID;
			t.estate = 2;
			ticketBound = true;
		} else {
			log(`${prefix} ⚠ Auth ticket bulunamadı — activeTickets: ${activeTickets.length}`);
		}
	} else {
		log(`${prefix} ⚠ _activeAuthTickets mevcut değil`);
	}
	if (!ticketBound) {
		throw new Error('Auth ticket binding başarısız — GC commend çalışmaz');
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

	commendResult = null;

	const commendPayload = CommendMsg.encode(CommendMsg.create({
		account_id: targetAccountId,
		match_id: 0,
		commendation: { cmd_friendly: 1, cmd_teaching: 1, cmd_leader: 1 },
		tokens: 0
	})).finish();
	bot.sendToGC(APP_ID, 9121, {}, Buffer.from(commendPayload));

	// Wait up to 8s for the GC reply, then retry once.
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
		const rcon2 = new Rcon(RCON_IP, RCON_PORT, RCON_PASS);
		await rcon2.connect();
		await rcon2.execute(`css_auth_end ${bot.steamID.getSteamID64()}`);
		rcon2.disconnect();
		_authSlotActive = false;
	} catch {}

	bot.logOff();

	const result = {
		success: commendResult !== null && commendResult.accepted === true,
		acked: commendResult !== null,
		category: commendResult ? commendResult.category : 'timeout',
		timeout: commendResult === null,
		response_type: commendResult ? commendResult.response_type : null,
		response_result: commendResult ? commendResult.response_result : null,
		account: account.username,
		tokens: commendResult ? commendResult.tokens : null
	};
	if (result.success) {
		log(`${prefix} ✓ OK (result=${result.response_result})`);
	} else if (result.acked) {
		log(`${prefix} ✗ ${result.category} (result=${result.response_result})`);
	} else {
		log(`${prefix} ✗ timeout`);
	}
	console.log('__RESULT__' + JSON.stringify(result));
	setTimeout(() => process.exit(result.success ? 0 : 1), 1500);
}

run().catch(async err => {
	const out = { success: false, account: account.username, error: err.message };
	if (err.eresult !== undefined) {
		out.eresult = err.eresult;
		// EResults that mean the account itself is unusable, so the pool can drop it.
		if ([5, 6, 18, 23, 65].includes(err.eresult)) {
			out.invalidAccount = true;
		}
	}
	if (!out.invalidAccount && /InvalidPassword|AccountDisabled|AccountNotFound|AccountLogonDenied/i.test(err.message)) {
		out.invalidAccount = true;
	}

	if (_authSlotActive && _myBotSteamID64) {
		try {
			const cleanupRcon = new Rcon(RCON_IP, RCON_PORT, RCON_PASS);
			const cleanupP = (async () => {
				await cleanupRcon.connect();
				await cleanupRcon.execute(`css_auth_end ${_myBotSteamID64}`);
				cleanupRcon.disconnect();
				_authSlotActive = false;
			})();
			await Promise.race([
				cleanupP,
				new Promise((_, rej) => setTimeout(() => rej(new Error('cleanup timeout 3s')), 3000))
			]);
		} catch {}
		out.authSlotLeaked = _authSlotActive;
		out.botSteamID64 = _myBotSteamID64;
	}

	console.log('__RESULT__' + JSON.stringify(out));
	try { bot.logOff(); } catch {}
	setTimeout(() => process.exit(1), 1500);
});
