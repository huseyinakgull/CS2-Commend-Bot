const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const SteamID = require('steamid');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const dgram = require('dgram');
const loadProtos = require('../helpers/Protos');
const Rcon = require('../helpers/Rcon');

const { validateServerSteamID, fetchGCVersion } = require('../helpers/ServerValidation');

const APP_ID = 730;
let GC_VERSION = 2000771;

const protos = loadProtos([
	{ name: 'cs2', protos: path.join(__dirname, '..', 'protobufs', 'cs2') },
]);
const HelloMsg    = protos.cs2.lookupType('CMsgClientHello');
const WelcomeMsg  = protos.cs2.lookupType('CMsgClientWelcome');
const AccDataResp = protos.cs2.lookupType('CMsgGCCStrike15_v2_MatchmakingGC2ClientHello');
const CommendMsg  = protos.cs2.lookupType('CMsgGCCStrike15_v2_ClientCommendPlayer');
const ResponseMsg = protos.cs2.lookupType('CMsgGCCStrike15_v2_ClientReportResponse');
const ProfileReqMsg  = protos.cs2.lookupType('CMsgGCCStrike15_v2_ClientRequestPlayersProfile');
const ProfileRespMsg = protos.cs2.lookupType('CMsgGCCStrike15_v2_PlayersProfile');

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

const RCON_LOCK_FILE = path.join(__dirname, '..', '.rcon.lock');

function killChildAndFreeLock(child, logger) {
	if (!child) return;
	try { child.kill('SIGTERM'); } catch {}
	try {
		if (fs.existsSync(RCON_LOCK_FILE)) {
			fs.unlinkSync(RCON_LOCK_FILE);
			if (logger && logger.debug) logger.debug('RCON lock parent tarafından temizlendi (child kill)');
		}
	} catch {}
	setTimeout(() => {
		try {
			if (child.exitCode === null && !child.killed) {
				child.kill('SIGKILL');
			}
		} catch {}
	}, 1000).unref();
}

function parseServerSteamID(statusOutput) {
	const m = statusOutput.match(/steamid\s*:\s*(\d+)/i)
		|| statusOutput.match(/\[A:\d+:\d+:\d+\]\s*\((\d+)\)/)
		|| statusOutput.match(/SteamID\s*=\s*\[A:\d+:\d+:\d+\]\s*\((\d+)\)/)
		|| statusOutput.match(/(\d{15,})/);
	return m ? m[1] : null;
}

class Bot {
	constructor(account, logger, proxy) {
		this.username = account.username;
		this._account = account;
		this.log = logger;
		this.proxy = proxy || null;
		this.state = 'offline';
		this.accountId = null;
		this.steamId = null;
		this._steam = null;
		this._sessionTicket = null;
		this._serverSteamID = null;
		this._commendsThisSession = 0;
		this._commendsSuccess = 0;
		this._commendsFail = 0;
		this._startTime = null;
		this._lastCommendTime = 0;
		this._lastError = null;
		this._reconnectAttempts = 0;
		this.isOnCooldown = false;
		this._commendedTargets = new Set();
	}

	hasCommended(targetAccountId) {
		return this._commendedTargets.has(targetAccountId);
	}

	get isReady()    { return this.state === 'on_server'; }
	get isOnServer() { return this.state === 'on_server'; }
	get isLoggedIn() { return this.state === 'gc_ready' || this.state === 'on_server'; }
	get uptime()     { return this._startTime ? Date.now() - this._startTime : 0; }
	get successRate() {
		const total = this._commendsSuccess + this._commendsFail;
		return total > 0 ? Math.round((this._commendsSuccess / total) * 100) : 0;
	}

	toJSON() {
		return {
			username: this.username,
			state: this.state,
			steamId: this.steamId,
			accountId: this.accountId,
			proxy: this.proxy ? this.proxy.replace(/:[^:@]+@/, ':***@') : null,
			isReady: this.isReady,
			isOnServer: this.isOnServer,
			isOnCooldown: this.isOnCooldown,
			uptime: this.uptime,
			commendsTotal: this._commendsThisSession,
			commendsSuccess: this._commendsSuccess,
			commendsFail: this._commendsFail,
			successRate: this.successRate,
			lastCommendTime: this._lastCommendTime,
			lastError: this._lastError,
			reconnectAttempts: this._reconnectAttempts
		};
	}

	async login() {
		if (this.isLoggedIn || this.state === 'on_server') return;

		this.state = 'logging_in';
		this._lastError = null;

		const steamOpts = { autoRelogin: false };
		if (this.proxy) {
			steamOpts.httpProxy = this.proxy;
		}
		this._steam = new SteamUser(steamOpts);

		await new Promise((resolve, reject) => {
			const loginTimeout = setTimeout(() => reject(new Error('Login timeout (30s)')), 30000);
			this._steam.logOn({
				accountName: this._account.username,
				password: this._account.password,
				twoFactorCode: (this._account.sharedSecret && this._account.sharedSecret.length > 5)
					? SteamTotp.getAuthCode(this._account.sharedSecret) : undefined
			});
			this._steam.once('loggedOn', () => { clearTimeout(loginTimeout); resolve(); });
			this._steam.once('error', (err) => { clearTimeout(loginTimeout); reject(err); });
		});

		this.steamId = this._steam.steamID.getSteamID64();
		this.accountId = this._steam.steamID.accountid;
		this.state = 'online';
		this._startTime = Date.now();
		this._reconnectAttempts = 0;

		try { await this._steam.requestFreeLicense(APP_ID); } catch {}

		this._steam.on('receivedFromGC', (appid, type, body) => {
			if (appid !== APP_ID) return;
			if (type === 4004) {
				try {
					const welcome = WelcomeMsg.toObject(WelcomeMsg.decode(body), { defaults: true });
					if (welcome.version && welcome.version > 0 && welcome.version !== GC_VERSION) {
						this.log.warn(`[GC] Version güncellendi: ${GC_VERSION} → ${welcome.version}`);
						GC_VERSION = welcome.version;
					}
				} catch {}
			}
		});

		this._steam.gamesPlayed(APP_ID);
		await wait(2000);

		this.state = 'gc_ready';

		this._steam.on('authTicketStatus', () => {});

		this._steam.on('receivedFromGC', (appid, type) => {
			if (appid !== APP_ID) return;
			if (type === 9122) {
				this.log.info(`[${this.username}] GC >> [COMMEND_RESPONSE]`);
			}
		});

		this._steam.on('error', (err) => {
			this.state = 'error';
			this._lastError = err.message;
			this.log.warn(`[${this.username}] Disconnected: ${err.message}`);
		});

		this._steam.on('disconnected', () => {
			if (this.state !== 'offline') {
				this.state = 'error';
				this._lastError = 'Disconnected from Steam';
			}
		});
	}

	async authOnServer(rcon) {
		if (this.state !== 'gc_ready') {
			throw new Error(`Bot not in gc_ready state (current: ${this.state})`);
		}
		if (!this._steam) {
			throw new Error('Bot disconnected');
		}

		const { sessionTicket } = await this._steam.createAuthSessionTicket(APP_ID);
		this._sessionTicket = sessionTicket;
		this.log.info(`[${this.username}] Ticket: ${sessionTicket.length} bytes`);

		await rcon.execute(`css_auth_end ${this.steamId}`);

		const ticketHex = this._sessionTicket.toString('hex');
		const CHUNK = 400;
		for (let i = 0; i < ticketHex.length; i += CHUNK) {
			await rcon.execute(`css_auth_data ${ticketHex.slice(i, i + CHUNK)}`);
		}

		const authResp = await rcon.execute(`css_auth_go ${this.steamId}`);
		const authLine = authResp.trim();

		const isAuthError = authLine.includes('InvalidTicket')
			|| authLine.includes('no_ticket_data')
			|| authLine.includes('AUTH 1');

		if (isAuthError) {
			throw new Error(`Auth failed: ${authLine}`);
		}

	}

	async bindTicket(serverSteamID) {
		this._serverSteamID = serverSteamID;

		await wait(2000);
		const activeTickets = this._steam._activeAuthTickets;
		if (activeTickets) {
			const t = activeTickets.find(t => t.gameid == APP_ID);
			if (t) { t.steamid = this._serverSteamID; t.estate = 2; }
		}
		this._steam.gamesPlayed({ game_id: APP_ID, steam_id_gs: this._serverSteamID });
		await this._steam._sendAuthList(APP_ID);
		await wait(2000);

		this._sendHello();
		await wait(2000);
		this.state = 'on_server';
	}

	async joinServer(rcon, serverSteamID) {
		await this.authOnServer(rcon);
		await this.bindTicket(serverSteamID);
	}

	async connect(serverIP, serverPort, rconPassword) {
		try {
			await this.login();

			const rcon = new Rcon(serverIP, parseInt(serverPort), rconPassword);
			await rcon.connect();

			const status = await rcon.execute('status');
			const serverSteamID = parseServerSteamID(status);
			if (!serverSteamID) {
				rcon.disconnect();
				throw new Error('Server SteamID alınamadı');
			}

			await this.joinServer(rcon, serverSteamID);
			rcon.disconnect();
		} catch (err) {
			this.state = 'error';
			this._lastError = err.message;
			this.log.error(`[${this.username}] Connect failed: ${err.message}`);
			throw err;
		}
	}

	async sendCommend(targetAccountId, commendTypes = {}) {
		if (!this.isReady) throw new Error('Bot not ready');
		if (!this._steam) throw new Error('Bot disconnected');

		if (this._commendedTargets.has(targetAccountId)) {
			throw new Error('Already commended this target');
		}

		const friendly = commendTypes.friendly !== false ? 1 : 0;
		const teaching = commendTypes.teaching !== false ? 1 : 0;
		const leader = commendTypes.leader !== false ? 1 : 0;

		const commendPayload = CommendMsg.encode(CommendMsg.create({
			account_id: targetAccountId,
			match_id: 0,
			commendation: { cmd_friendly: friendly, cmd_teaching: teaching, cmd_leader: leader },
			tokens: 0
		})).finish();

		const responseBody = await this._sendAndWaitCommend(commendPayload, 10000);

		this._commendsThisSession++;
		this._lastCommendTime = Date.now();

		if (!responseBody) {
			this._commendsFail++;
			return { success: false, timeout: true, tokens: null };
		}

		this._commendsSuccess++;
		this._commendedTargets.add(targetAccountId);
		const r = ResponseMsg.toObject(ResponseMsg.decode(responseBody), { defaults: true, longs: Number });
		return { success: true, tokens: r.tokens };
	}

	async _sendAndWaitCommend(commendPayload, timeoutMs) {
		const responsePromise = this._waitForGCMessage(9122, timeoutMs);
		this._steam.sendToGC(APP_ID, 9121, {}, Buffer.from(commendPayload));
		return responsePromise;
	}

	async requestPlayerProfile(targetAccountId) {
		if (!this._steam) throw new Error('Bot disconnected');
		if (this.state !== 'gc_ready' && this.state !== 'on_server') {
			throw new Error('Bot not GC ready');
		}

		const payload = ProfileReqMsg.encode(ProfileReqMsg.create({
			account_id: targetAccountId,
			request_level: 32
		})).finish();

		const responsePromise = this._waitForGCMessage(9128, 8000);
		this._steam.sendToGC(APP_ID, 9127, {}, Buffer.from(payload));
		const responseBody = await responsePromise;

		if (!responseBody) {
			throw new Error('Profile request timeout (8s)');
		}

		const profile = ProfileRespMsg.toObject(ProfileRespMsg.decode(responseBody), { defaults: true, longs: Number });

		if (profile.account_profiles && profile.account_profiles.length > 0) {
			const p = profile.account_profiles[0];
			const c = p.commendation || {};
			return {
				friendly: c.cmd_friendly || 0,
				teaching: c.cmd_teaching || 0,
				leader: c.cmd_leader || 0
			};
		}

		throw new Error('No profile data in response');
	}

	disconnect() {
		if (this._steam) {
			try { this._steam.logOff(); } catch {}
			this._steam = null;
		}
		this._sessionTicket = null;
		this._consecutiveTimeouts = 0;
		this.state = 'offline';
		this._lastError = null;
	}

	_sendHello() {
		if (!this._steam) return;
		const payload = HelloMsg.encode(HelloMsg.create({
			version: GC_VERSION,
			client_session_need: 1,
			client_launcher: 0,
			steam_launcher: 0
		})).finish();
		this._steam.sendToGC(APP_ID, 4006, {}, Buffer.from(payload));
	}

	async refreshGC() {
		if (!this._steam) throw new Error('Bot disconnected');

		for (let attempt = 0; attempt < 3; attempt++) {
			this._steam.gamesPlayed([]);
			await wait(3000);
			this._steam.gamesPlayed(APP_ID);
			await wait(3000);
			this._sendHello();
			const accountData = await this._waitForGCMessage(9110, 15000);
			if (accountData) return;
		}
		throw new Error('GC refresh failed (3 attempts)');
	}

	_waitForGCMessage(targetType, timeoutMs) {
		return new Promise((resolve) => {
			const steam = this._steam;
			if (!steam) return resolve(null);

			const timer = setTimeout(() => {
				try { steam.removeListener('receivedFromGC', handler); } catch {}
				resolve(null);
			}, timeoutMs);
			const handler = (appid, type, body) => {
				if (appid === APP_ID && type === targetType) {
					clearTimeout(timer);
					try { steam.removeListener('receivedFromGC', handler); } catch {}
					resolve(body);
				}
			};
			steam.on('receivedFromGC', handler);
		});
	}
}

class BotManager extends EventEmitter {
	constructor(accounts, serverConfig, logger, options = {}) {
		super();
		this._accounts = accounts;
		this._serverIP = serverConfig.ip;
		this._serverPort = serverConfig.port || '27015';
		this._rconPassword = serverConfig.password;
		this._rconIp = serverConfig.rconIp || serverConfig.ip;
		this._steamApiKey = options.steamApiKey || serverConfig.steamApiKey || null;
		this._busyAccounts = new Set();

		this._connectedPlayers = new Set();
		this._logReceiverIp = serverConfig.logReceiverIp || options.logReceiverIp || null;
		this._logReceiverPort = parseInt(serverConfig.logReceiverPort || options.logReceiverPort || 0) || 27500;
		this._logSocket = null;
		this._logListenerReady = false;
		this.log = logger;
		this.bots = [];
		this._roundRobinIndex = 0;
		this._healthTimer = null;
		this._autoReconnect = options.autoReconnect !== false;
		this._healthInterval = options.healthInterval || 60000;

		this._rconBusy = false;
		this._rconQueue = [];

		this._commendCache = new Map();
		this._botUsageCount = new Map();
		this._accountNextIndex = new Map();
		this._botFailures = new Map();
		this._commendCacheFile = path.join(__dirname, 'commend-cache.json');
		this._commendsSinceMapChange = 0;
		this._mapChangeThreshold = 100;
		this._mapChangePromise = null;

		this._cachedServerSteamID = null;
		this._cachedServerSteamIDTime = 0;

		this._proxies = [];
		this._proxyMode = options.proxyMode || 'round-robin';
		this._proxyInsecureTls = options.proxyInsecureTls === true || process.env.PROXY_INSECURE_TLS === '1';
		if (this._proxyInsecureTls) {
			logger.warn('proxy.insecureTls is enabled: TLS certificate verification is disabled for proxied bot connections');
		}
		this._proxySwitchEvery = options.proxySwitchEvery || 3;

		this._stats = {
			startTime: Date.now(),
			totalCommends: 0,
			totalSuccess: 0,
			totalFail: 0,
			totalReconnects: 0
		};

		const cfgPipeline = (options.pipeline) || {};
		this._pipelineConfig = {
			pipelineSize:        cfgPipeline.pipelineSize        || 4,
			staggerMs:           cfgPipeline.staggerMs           || 5000,
			maxConsecutiveFails: cfgPipeline.maxConsecutiveFails || 35,
			throttleEvery:       cfgPipeline.throttleEvery       || 15,
			throttleMs:          cfgPipeline.throttleMs          || 75000,
			maxParallelChildren: cfgPipeline.maxParallelChildren || 6
		};

		this._activeChildrenCount = 0;
		this._childSlotWaiters = [];
	}

	setPipelineConfig(partial) {
		if (!partial || typeof partial !== 'object') return this._pipelineConfig;
		const validKeys = ['pipelineSize', 'staggerMs', 'maxConsecutiveFails', 'throttleEvery', 'throttleMs', 'maxParallelChildren'];
		const updates = {};
		for (const k of validKeys) {
			if (partial[k] !== undefined && partial[k] !== null) {
				const v = Number(partial[k]);
				if (!Number.isFinite(v) || v <= 0) continue;
				this._pipelineConfig[k] = v;
				updates[k] = v;
			}
		}
		if (Object.keys(updates).length > 0) {
			this.log.info(`Pipeline config güncellendi: ${JSON.stringify(updates)}`);
		}
		return { ...this._pipelineConfig };
	}

	getPipelineConfig() {
		return { ...this._pipelineConfig, activeChildren: this._activeChildrenCount };
	}

	async _acquireChildSlot() {
		const cap = this._pipelineConfig.maxParallelChildren;
		if (this._activeChildrenCount < cap) {
			this._activeChildrenCount++;
			return;
		}
		await new Promise(resolve => this._childSlotWaiters.push(resolve));
		this._activeChildrenCount++;
	}

	_releaseChildSlot() {
		this._activeChildrenCount = Math.max(0, this._activeChildrenCount - 1);
		const next = this._childSlotWaiters.shift();
		if (next) next();
	}

	_withRcon(fn) {
		return new Promise((resolve, reject) => {
			this._rconQueue.push({ fn, resolve, reject });
			if (!this._rconBusy) this._processRconQueue();
		});
	}

	async _processRconQueue() {
		if (this._rconBusy || this._rconQueue.length === 0) return;
		this._rconBusy = true;

		const { fn, resolve, reject } = this._rconQueue.shift();
		let rcon;

		try {
			rcon = new Rcon(this._rconIp, parseInt(this._serverPort), this._rconPassword);
			await rcon.connect();

			if (!this._cachedServerSteamID || Date.now() - this._cachedServerSteamIDTime > 300000) {
				const status = await rcon.execute('status');
				this._cachedServerSteamID = parseServerSteamID(status);
				this._cachedServerSteamIDTime = Date.now();
				if (!this._cachedServerSteamID) {
					throw new Error('Server SteamID alınamadı');
				}
				const v = validateServerSteamID(this._cachedServerSteamID);
				if (!v.valid) {
					this._cachedServerSteamID = null;
					throw new Error(v.reason);
				}
				if (v.warning) this.log.info(v.warning);
			}

			const result = await fn(rcon, this._cachedServerSteamID);
			resolve(result);
		} catch (err) {
			reject(err);
		} finally {
			if (rcon) try { rcon.disconnect(); } catch {}
			this._rconBusy = false;
			if (this._rconQueue.length > 0) {
				this._processRconQueue();
			}
		}
	}

	_proxyFilePath() {
		return path.join(__dirname, 'proxies.json');
	}

	_saveProxies() {
		try {
			const data = { proxies: this._proxies, mode: this._proxyMode, switchEvery: this._proxySwitchEvery };
			fs.writeFileSync(this._proxyFilePath(), JSON.stringify(data, null, 2), 'utf8');
		} catch (err) {
			this.log.error(`proxies.json kaydedilemedi: ${err.message}`);
		}
	}

	_loadProxiesFromDisk() {
		try {
			const filePath = this._proxyFilePath();
			if (!fs.existsSync(filePath)) return;
			const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
			if (data.proxies && Array.isArray(data.proxies)) {
				this._proxies = data.proxies;
				this.log.info(`${this._proxies.length} proxy diskten yüklendi`);
			}
			if (data.mode) this._proxyMode = data.mode;
			if (data.switchEvery) this._proxySwitchEvery = data.switchEvery;
		} catch (err) {
			this.log.warn(`proxies.json okunamadı: ${err.message}`);
		}
	}

	reloadProxies() {
		const prev = this._proxies.length;
		this._proxies = [];
		this._loadProxiesFromDisk();
		this._proxyCounter = 0;
		this.log.info(`Proxies reloaded: ${prev} → ${this._proxies.length} (mode=${this._proxyMode})`);
		return {
			previousCount: prev,
			currentCount: this._proxies.length,
			mode: this._proxyMode
		};
	}

	_loadCommendCache() {
		try {
			if (!fs.existsSync(this._commendCacheFile)) return;
			const raw = fs.readFileSync(this._commendCacheFile, 'utf8');
			if (!raw.trim()) return;
			const data = JSON.parse(raw);

			let purgedSet = new Set();
			try {
				const invalidPath = path.join(__dirname, '..', 'accounts.invalid.json');
				if (fs.existsSync(invalidPath)) {
					const invalid = JSON.parse(fs.readFileSync(invalidPath, 'utf8')) || [];
					for (const acc of invalid) if (acc && acc.username) purgedSet.add(acc.username);
				}
			} catch {}

			let stalePurged = 0;
			if (data.commendCache) {
				for (const [target, usernames] of Object.entries(data.commendCache)) {
					const key = Number(target) || target;
					const filtered = new Set();
					for (const u of usernames) {
						if (purgedSet.has(u)) { stalePurged++; continue; }
						filtered.add(u);
					}
					this._commendCache.set(key, filtered);
				}
				const totalEntries = Array.from(this._commendCache.values()).reduce((sum, s) => sum + s.size, 0);
				const suffix = stalePurged > 0 ? ` (${stalePurged} purged username temizlendi)` : '';
				this.log.success(`Commend cache diskten yüklendi: ${this._commendCache.size} hedef, ${totalEntries} kayıt${suffix}`);
			}
			if (data.botUsageCount && typeof data.botUsageCount === 'object') {
				let loaded = 0, purgedSkip = 0;
				for (const [username, count] of Object.entries(data.botUsageCount)) {
					if (purgedSet.has(username)) { purgedSkip++; continue; }
					if (typeof count === 'number' && count > 0) {
						this._botUsageCount.set(username, count);
						loaded++;
					}
				}
				if (loaded > 0) this.log.success(`Bot kullanım sayacı yüklendi: ${loaded} bot${purgedSkip > 0 ? ` (${purgedSkip} purged skip)` : ''}`);
			} else if (data.accountNextIndex) {
				const maxIdx = Object.values(data.accountNextIndex).reduce((m, v) => Math.max(m, Number(v) || 0), 0);
				if (maxIdx > 0 && Array.isArray(this._accounts) && this._accounts.length > 0) {
					const limit = Math.min(maxIdx, this._accounts.length);
					for (let i = 0; i < limit; i++) {
						const username = this._accounts[i]?.username;
						if (username) this._botUsageCount.set(username, 1);
					}
					this.log.info(`Migration: eski per-target Map'inden ${limit} hesaba baseline usage atandı (LRU adaleti için)`);
				}
			}
			if (data.botFailures) {
				const now = Date.now();
				const STALE_MS = 24 * 60 * 60 * 1000;
				let loaded = 0, skipped = 0, purgedSkip = 0;
				for (const [username, f] of Object.entries(data.botFailures)) {
					if (!f || typeof f !== 'object') continue;
					if (purgedSet.has(username)) { purgedSkip++; continue; }
					if (f.lastFailTime && (now - f.lastFailTime) > STALE_MS) {
						skipped++;
						continue;
					}
					this._botFailures.set(username, {
						consecutiveFails: f.consecutiveFails || 0,
						totalFails: f.totalFails || 0,
						totalSuccess: f.totalSuccess || 0,
						lastFailTime: f.lastFailTime || 0
					});
					loaded++;
				}
				if (loaded > 0 || skipped > 0 || purgedSkip > 0) {
					const purgedSuffix = purgedSkip > 0 ? `, ${purgedSkip} purged` : '';
					this.log.success(`Bot fail history diskten yüklendi: ${loaded} kayıt (${skipped} eski/atıldı${purgedSuffix})`);
				}
			}
		} catch (err) {
			this.log.warn(`commend-cache.json okunamadı: ${err.message}`);
		}
	}

	_purgeInvalidAccount(username, reason) {
		if (!this._purgedAccounts) this._purgedAccounts = new Set();
		if (this._purgedAccounts.has(username)) return;
		this._purgedAccounts.add(username);

		const before = this._accounts.length;
		const removed = this._accounts.find(a => a.username === username);
		this._accounts = this._accounts.filter(a => a.username !== username);
		const after = this._accounts.length;

		const existingBot = this.bots.find(b => b.username === username);
		if (existingBot) {
			try { existingBot.disconnect(); } catch {}
			this.bots = this.bots.filter(b => b !== existingBot);
		}

		const accountsPath = path.join(__dirname, '..', 'accounts.json');
		try {
			fs.writeFileSync(accountsPath, JSON.stringify(this._accounts, null, 2), 'utf8');
		} catch (err) {
			this.log.warn(`accounts.json güncellenemedi: ${err.message}`);
		}

		if (removed) {
			const invalidPath = path.join(__dirname, '..', 'accounts.invalid.json');
			let archive = [];
			try {
				if (fs.existsSync(invalidPath)) {
					archive = JSON.parse(fs.readFileSync(invalidPath, 'utf8')) || [];
				}
			} catch {}
			archive.push({ ...removed, removedAt: new Date().toISOString(), reason });
			try {
				fs.writeFileSync(invalidPath, JSON.stringify(archive, null, 2), 'utf8');
			} catch (err) {
				this.log.warn(`accounts.invalid.json yazılamadı: ${err.message}`);
			}
		}

		let cacheRemovals = 0;
		try {
			if (this._botUsageCount && this._botUsageCount.delete(username)) cacheRemovals++;
			if (this._botFailures   && this._botFailures.delete(username))   cacheRemovals++;
			if (this._commendCache) {
				for (const [, usernames] of this._commendCache) {
					if (usernames && usernames.delete(username)) cacheRemovals++;
				}
			}
		} catch (err) {
			this.log.warn(`runtime cache temizliği hata: ${err.message}`);
		}

		this.log.error(`Hesap havuzdan atıldı: ${username} (${reason}) — ${before}→${after} hesap${cacheRemovals ? ` [cache: -${cacheRemovals} ref]` : ''}`);
	}

	async startLogReceiver() {
		if (!this._logReceiverIp) {
			this.log.warn(`logReceiverIp ayarlanmamış — canlı oyuncu takibi devre dışı (Steam API'ye düşülecek)`);
			return;
		}
		if (this._logSocket) return;

		const sock = dgram.createSocket('udp4');
		this._logSocket = sock;

		const allowedSources = new Set([this._serverIP, '127.0.0.1', '::1', '::ffff:127.0.0.1']);
		sock.on('message', (msg, rinfo) => {
			if (!allowedSources.has(rinfo.address)) return;
			this._handleLogPacket(msg);
		});

		sock.on('error', (err) => {
			this.log.error(`Log receiver hatası: ${err.message}`);
			try { sock.close(); } catch {}
			this._logSocket = null;
			this._logListenerReady = false;
		});

		await new Promise((resolve) => {
			sock.bind(this._logReceiverPort, () => {
				this.log.success(`Log receiver 0.0.0.0:${this._logReceiverPort} üzerinde dinleniyor (kabul edilen kaynak: ${this._serverIP})`);
				this._logListenerReady = true;
				resolve();
			});
		});

		try {
			const rcon = new Rcon(this._rconIp, parseInt(this._serverPort), this._rconPassword);
			await rcon.connect();
			const endpoint = `${this._logReceiverIp}:${this._logReceiverPort}`;
			await rcon.execute(`logaddress_add ${endpoint}`);
			await rcon.execute('log on');
			rcon.disconnect();
			this.log.success(`Sunucu log aktarımı yapılandırıldı → ${endpoint}`);
		} catch (err) {
			this.log.warn(`logaddress_add başarısız: ${err.message} — canlı takip çalışmayabilir`);
		}

		try {
			await this._seedConnectedPlayersFromStatus();
		} catch {}
	}

	async stopLogReceiver() {
		if (!this._logSocket) return;
		try {
			const rcon = new Rcon(this._rconIp, parseInt(this._serverPort), this._rconPassword);
			await rcon.connect();
			await rcon.execute(`logaddress_del ${this._logReceiverIp}:${this._logReceiverPort}`);
			rcon.disconnect();
		} catch {}
		try { this._logSocket.close(); } catch {}
		this._logSocket = null;
		this._logListenerReady = false;
	}

	_handleLogPacket(buf) {
		let text = '';
		for (let i = 0; i < buf.length; i++) {
			const c = buf[i];
			if (c >= 0x20 && c <= 0x7e) text += String.fromCharCode(c);
		}
		const parseAccId = (line) => {
			const cs2 = line.match(/\[U:1:(\d+)\]/);
			if (cs2) return parseInt(cs2[1]);
			const csgo = line.match(/STEAM_1:(\d):(\d+)/);
			if (csgo) return parseInt(csgo[2]) * 2 + parseInt(csgo[1]);
			return null;
		};
		if (/connected,\s*address/i.test(text) || /entered the game/i.test(text)) {
			const accId = parseAccId(text);
			if (accId !== null) {
				this._connectedPlayers.add(accId);
				this.log.info(`Oyuncu bağlandı: accountId=${accId} (sunucuda ${this._connectedPlayers.size} kişi)`);
				return;
			}
		}
		if (/disconnected/i.test(text)) {
			const accId = parseAccId(text);
			if (accId !== null) {
				this._connectedPlayers.delete(accId);
				this.log.info(`Oyuncu ayrıldı: accountId=${accId} (sunucuda ${this._connectedPlayers.size} kişi)`);
				return;
			}
		}
		if (/Started map|Loading map|changelevel/i.test(text)) {
			if (this._connectedPlayers.size > 0) {
				this.log.info(`Harita değişti — oyuncu listesi temizleniyor`);
				this._connectedPlayers.clear();
			}
		}
	}

	async _seedConnectedPlayersFromStatus() {
		const rcon = new Rcon(this._rconIp, parseInt(this._serverPort), this._rconPassword);
		try {
			await rcon.connect();
			const status = await rcon.execute('status');
			rcon.disconnect();
			let added = 0;
			const cs2Re = /\[U:1:(\d+)\]/g;
			let m;
			while ((m = cs2Re.exec(status)) !== null) {
				const accId = parseInt(m[1]);
				if (!this._connectedPlayers.has(accId)) {
					this._connectedPlayers.add(accId);
					added++;
				}
			}
			const csgoRe = /STEAM_1:(\d):(\d+)/g;
			while ((m = csgoRe.exec(status)) !== null) {
				const accId = parseInt(m[2]) * 2 + parseInt(m[1]);
				if (!this._connectedPlayers.has(accId)) {
					this._connectedPlayers.add(accId);
					added++;
				}
			}
			if (added > 0) this.log.info(`status çıktısından ${added} oyuncu yüklendi (toplam ${this._connectedPlayers.size})`);
		} catch (err) {
			rcon.disconnect();
		}
	}

	_saveCommendCache() {
		try {
			const data = { commendCache: {}, accountNextIndex: {}, botFailures: {}, botUsageCount: {}, savedAt: new Date().toISOString() };
			for (const [target, usernames] of this._commendCache) {
				data.commendCache[target] = Array.from(usernames);
			}
			for (const [target, idx] of this._accountNextIndex) {
				data.accountNextIndex[target] = idx;
			}
			if (this._botUsageCount && this._botUsageCount.size > 0) {
				for (const [username, count] of this._botUsageCount) {
					if (count > 0) data.botUsageCount[username] = count;
				}
			}
			if (this._botFailures && this._botFailures.size > 0) {
				for (const [username, f] of this._botFailures) {
					if (!f) continue;
					if ((f.totalFails || 0) === 0 && (f.totalSuccess || 0) === 0) continue;
					data.botFailures[username] = {
						consecutiveFails: f.consecutiveFails || 0,
						totalFails: f.totalFails || 0,
						totalSuccess: f.totalSuccess || 0,
						lastFailTime: f.lastFailTime || 0
					};
				}
			}
			fs.writeFileSync(this._commendCacheFile, JSON.stringify(data, null, 2), 'utf8');
		} catch (err) {
			this.log.error(`commend-cache.json kaydedilemedi: ${err.message}`);
		}
	}

	loadProxies(proxies) {
		this._proxies = proxies.filter(p => p && p.trim()).map(p => {
			p = p.trim();
			if (!p.startsWith('http') && !p.startsWith('socks')) {
				const parts = p.split(':');
				if (parts.length === 4) {
					p = `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
				} else {
					p = 'http://' + p;
				}
			}
			return p;
		});
		this._saveProxies();
		this.log.info(`${this._proxies.length} proxy yüklendi`);
		return this._proxies.length;
	}

	loadProxiesFromFile(filePath) {
		try {
			const content = fs.readFileSync(filePath, 'utf8');
			const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
			return this.loadProxies(lines);
		} catch (err) {
			this.log.warn(`Proxy dosyası okunamadı: ${err.message}`);
			return 0;
		}
	}

	getProxies() {
		return this._proxies.map(p => p.replace(/:[^:@]+@/, ':***@'));
	}

	addProxy(proxy) {
		if (!proxy.startsWith('http') && !proxy.startsWith('socks')) {
			const parts = proxy.split(':');
			if (parts.length === 4) {
				proxy = `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
			} else {
				proxy = 'http://' + proxy;
			}
		}
		if (!this._proxies.includes(proxy)) {
			this._proxies.push(proxy);
			this._saveProxies();
		}
		return this._proxies.length;
	}

	removeProxy(index) {
		if (index >= 0 && index < this._proxies.length) {
			this._proxies.splice(index, 1);
			this._saveProxies();
		}
		return this._proxies.length;
	}

	_getProxyForBot(index) {
		if (this._proxies.length === 0) return null;
		switch (this._proxyMode) {
			case 'per-account':
				return this._proxies[index % this._proxies.length];
			case 'random':
				return this._proxies[Math.floor(Math.random() * this._proxies.length)];
			case 'round-robin':
			default:
				return this._proxies[Math.floor(index / this._proxySwitchEvery) % this._proxies.length];
		}
	}

	get status() {
		const states = {};
		this.bots.forEach(b => { states[b.state] = (states[b.state] || 0) + 1; });
		return {
			total: this._accounts.length,
			ready: this.bots.filter(b => b.isReady || b.state === 'gc_ready').length,
			onServer: this.bots.filter(b => b.isOnServer).length,
			gcReady: this.bots.filter(b => b.state === 'gc_ready').length,
			error: this.bots.filter(b => b.state === 'error').length,
			offline: this._accounts.length - this.bots.length + this.bots.filter(b => b.state === 'offline').length,
			states,
			queueLength: this._rconQueue.length,
			gcVersion: GC_VERSION,
			server: { ip: this._serverIP, port: this._serverPort },
			proxies: this._proxies.length,
			proxyMode: this._proxyMode,
			stats: { ...this._stats, uptime: Date.now() - this._stats.startTime }
		};
	}

	get onServerBots() { return this.bots.filter(b => b.isOnServer); }

	getDetailedBotList() {
		return this.bots.map(b => b.toJSON());
	}

	static setGCVersion(version) {
		GC_VERSION = version;
	}

	static getGCVersion() {
		return GC_VERSION;
	}

	updateServer(ip, port, password, rconIp) {
		this._serverIP = ip;
		this._serverPort = port || '27015';
		this._rconPassword = password;
		this._rconIp = rconIp || ip;
		this._cachedServerSteamID = null;
		this.log.info(`Server güncellendi: ${ip}:${this._serverPort} (rcon: ${this._rconIp})`);
	}

	async testRcon() {
		const rcon = new Rcon(this._rconIp, parseInt(this._serverPort), this._rconPassword);
		try {
			await rcon.connect();
			const status = await rcon.execute('status');
			rcon.disconnect();
			const serverSteamID = parseServerSteamID(status);
			const playersMatch = status.match(/players\s*:\s*(\d+)\s+humans/i);
			return {
				success: true,
				serverSteamID,
				players: playersMatch ? parseInt(playersMatch[1]) : 0,
				statusSnippet: status.substring(0, 500)
			};
		} catch (err) {
			return { success: false, error: err.message };
		}
	}

	// Commends are only accepted while the target is on our server, so this is
	// checked before an order starts. Sources, most reliable first: the plugin's
	// css_is_on_server, the UDP log stream plus "status", then the Steam Web API.
	// Returns true / false, or null when nothing could be checked.
	async checkPlayerOnServer(targetAccountId) {
		let pluginSaysOff = false;

		if (this._pluginCheckAvailable === false) {
			// Plugin missing on this server; go straight to the fallbacks.
		} else try {
			const sid = new SteamID();
			sid.universe = 1; sid.type = 1; sid.instance = 1;
			sid.accountid = Number(targetAccountId);
			const steamid64 = sid.getSteamID64();

			const rcon = new Rcon(this._rconIp, parseInt(this._serverPort), this._rconPassword);
			await rcon.connect();
			let reply = '';
			try {
				reply = await rcon.execute(`css_is_on_server ${steamid64}`);
			} finally {
				try { rcon.disconnect(); } catch {}
			}

			const text = String(reply || '').trim();
			if (/Unknown command/i.test(text)) {
				this._pluginCheckAvailable = false;
				this.log.info(`CSSharp plugin bulunamadı — UDP/Steam fallback kalıcı olarak kullanılacak`);
			} else if (/\bON\b/.test(text) && text.includes(steamid64)) {
				this._pluginCheckAvailable = true;
				this.log.info(`checkPlayerOnServer (plugin): ${steamid64} SUNUCUDA`);
				return true;
			} else if (/\bOFF\b/.test(text) && text.includes(steamid64)) {
				this._pluginCheckAvailable = true;
				pluginSaysOff = true;
				this.log.info(`checkPlayerOnServer (plugin): ${steamid64} OFF → Steam API ile çapraz doğrulama`);
			} else {
				this.log.warn(`checkPlayerOnServer (plugin) beklenmeyen cevap: "${text}" — fallback kullanılacak`);
			}
		} catch (err) {
			this.log.warn(`checkPlayerOnServer (plugin) hata: ${err.message} — fallback kullanılacak`);
		}

		if (this._logListenerReady) {
			let here = this._connectedPlayers.has(Number(targetAccountId));
			if (!here) {
				try {
					await this._seedConnectedPlayersFromStatus();
					here = this._connectedPlayers.has(Number(targetAccountId));
				} catch {}
			}
			if (here) {
				this.log.info(`checkPlayerOnServer (UDP+status): accountId=${targetAccountId} SUNUCUDA (toplam ${this._connectedPlayers.size})`);
				return true;
			}
			this.log.info(`checkPlayerOnServer (UDP+status): accountId=${targetAccountId} eşleşme yok — Steam Web API'ye düşülüyor`);
		}

		if (!this._steamApiKey) {
			this.log.warn(`checkPlayerOnServer: Steam API key yok + UDP kapalı — kontrol atlanıyor`);
			return pluginSaysOff ? false : null;
		}

		const sid = new SteamID();
		sid.universe = 1;
		sid.type = 1;
		sid.instance = 1;
		sid.accountid = targetAccountId;
		const steamid64 = sid.getSteamID64();

		const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(this._steamApiKey)}&steamids=${steamid64}`;

		return new Promise((resolve) => {
			const https = require('https');
			const req = https.get(url, { timeout: 8000 }, (res) => {
				let body = '';
				res.on('data', (c) => body += c);
				res.on('end', () => {
					try {
						const data = JSON.parse(body);
						const player = data.response && data.response.players && data.response.players[0];
						if (!player) {
							this.log.warn(`checkPlayerOnServer: oyuncu bulunamadı (${steamid64})`);
							return resolve(pluginSaysOff ? false : null);
						}

						if (player.communityvisibilitystate !== undefined && player.communityvisibilitystate !== 3) {
							this.log.info(`checkPlayerOnServer: Profil gizli (${steamid64})`);
							return resolve(pluginSaysOff ? false : null);
						}

						const gameId = String(player.gameid || '');
						const gsIp = player.gameserverip || '';

						if (gsIp) {
							const onOurServer = gsIp.startsWith(this._serverIP + ':') || gsIp === this._serverIP;
							if (onOurServer) {
								if (pluginSaysOff) {
									this.log.warn(`checkPlayerOnServer: Plugin OFF dedi ama Steam API HEDEF sunucumuzda diyor (${gsIp}) → API'ye güveniyorum`);
								} else {
									this.log.info(`checkPlayerOnServer: HEDEF sunucumuzda (${gsIp})`);
								}
								return resolve(true);
							}
							this.log.info(`checkPlayerOnServer: Hedef farklı bir sunucuda (${gsIp})`);
							return resolve(false);
						}

						if (gameId && gameId !== '730') {
							this.log.info(`checkPlayerOnServer: Hedef farklı oyun oynuyor (gameid=${gameId})`);
							return resolve(false);
						}

						if (pluginSaysOff) {
							this.log.info(`checkPlayerOnServer: Plugin OFF + Steam API belirsiz → false (sunucuda değil)`);
							return resolve(false);
						}
						this.log.info(`checkPlayerOnServer: Belirsiz (gameid=${gameId || 'yok'}, gsIp=yok) — kontrol atlanıyor`);
						return resolve(null);
					} catch (err) {
						this.log.warn(`checkPlayerOnServer parse hatası: ${err.message}`);
						resolve(pluginSaysOff ? false : null);
					}
				});
			});
			req.on('error', (err) => {
				this.log.warn(`checkPlayerOnServer ağ hatası: ${err.message}`);
				resolve(pluginSaysOff ? false : null);
			});
			req.on('timeout', () => {
				req.destroy();
				this.log.warn(`checkPlayerOnServer timeout`);
				resolve(pluginSaysOff ? false : null);
			});
		});
	}

	async startAll() {
		try {
			GC_VERSION = await fetchGCVersion(this.log, GC_VERSION);
		} catch {}

		this.log.info(`${this._accounts.length} hesap havuzda, on-demand bağlantı aktif`);
		this._loadProxiesFromDisk();

		this._loadCommendCache();

		await this._applyServerSettings();

		try { await this.startLogReceiver(); } catch (err) {
			this.log.warn(`Log receiver başlatılamadı: ${err.message}`);
		}

		const lockFile = path.join(__dirname, '..', '.rcon.lock');
		try { fs.unlinkSync(lockFile); } catch {}

		if (this._autoReconnect) this._startHealthMonitor();
		this.emit('statusUpdate', this.status);
	}

	async connectBotsOnDemand(targetAccountId, neededCount) {
		const availableEligible = this.bots.filter(b =>
			b.state === 'gc_ready' && !b.hasCommended(targetAccountId)
		);
		if (availableEligible.length >= neededCount) return availableEligible.length;

		const candidateAccounts = this._accounts.filter(a => {
			const existingBot = this.bots.find(b => b.username === a.username);
			if (existingBot && existingBot.hasCommended(targetAccountId)) return false;
			if (existingBot && existingBot.state === 'gc_ready') return false;
			return true;
		});

		const stillNeeded = neededCount - availableEligible.length;
		const toConnect = candidateAccounts.slice(0, Math.max(0, stillNeeded));

		if (toConnect.length === 0) {
			this.log.warn('Bağlanacak uygun hesap kalmadı');
			return availableEligible.length;
		}

		this.log.info(`On-demand: ${toConnect.length} hesap login olacak (hedef: ${targetAccountId})`);

		const BATCH_SIZE = 5;

		for (let i = 0; i < toConnect.length; i += BATCH_SIZE) {
			const batch = toConnect.slice(i, i + BATCH_SIZE);
			const promises = batch.map(async (account) => {
				const existing = this.bots.find(b => b.username === account.username);
				if (existing) {
					existing.disconnect();
					this.bots = this.bots.filter(b => b !== existing);
				}

				const idx = this._accounts.indexOf(account);
				const proxy = this._getProxyForBot(idx);
				const bot = new Bot(account, this.log, proxy);
				this.bots.push(bot);

				try {
					await bot.login();
				} catch (err) {
					this.log.error(`[${account.username}] Login failed: ${err.message}`);
				}
			});

			await Promise.all(promises);
			this.emit('statusUpdate', this.status);

			const currentAvailable = this.bots.filter(b =>
				b.state === 'gc_ready' && !b.hasCommended(targetAccountId)
			).length;
			if (currentAvailable >= neededCount) {
				this.log.info(`On-demand: Yeterli bot hazır (${currentAvailable}/${neededCount}), login durduruldu`);
				break;
			}
		}

		const totalAvailable = this.bots.filter(b =>
			b.state === 'gc_ready' && !b.hasCommended(targetAccountId)
		).length;
		this.log.success(`On-demand: ${totalAvailable} bot login oldu ve hazır`);
		return totalAvailable;
	}

	async _joinBotWithRetry(bot, maxRetries) {
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				if (attempt > 0 && bot._steam) {
					bot.state = 'gc_ready';
					try {
						const { sessionTicket } = await bot._steam.createAuthSessionTicket(APP_ID);
						bot._sessionTicket = sessionTicket;
					} catch (ticketErr) {
						this.log.error(`[${bot.username}] Yeni ticket alınamadı: ${ticketErr.message}`);
						break;
					}
				}

				await this._withRcon(async (rcon, serverSteamID) => {
					await bot.joinServer(rcon, serverSteamID);
				});
				return true;
			} catch (err) {
				if (attempt < maxRetries) {
					this.log.warn(`[${bot.username}] Auth retry ${attempt + 1}: ${err.message}`);
					await wait(2000);
				} else {
					this.log.error(`[${bot.username}] Server join failed: ${err.message}`);
					bot.state = 'error';
					bot._lastError = err.message;
				}
			}
		}
		return false;
	}

	async connectAllBots() {
		this.log.info(`Tüm botlar login olacak (${this._accounts.length} hesap)...`);

		const BATCH_SIZE = 5;

		for (let i = 0; i < this._accounts.length; i += BATCH_SIZE) {
			const batch = this._accounts.slice(i, i + BATCH_SIZE);
			const promises = batch.map(async (account) => {
				const existing = this.bots.find(b => b.username === account.username);
				if (existing && (existing.isReady || existing.state === 'gc_ready')) return;

				if (existing) {
					existing.disconnect();
					this.bots = this.bots.filter(b => b !== existing);
				}

				const idx = this._accounts.indexOf(account);
				const proxy = this._getProxyForBot(idx);
				const bot = new Bot(account, this.log, proxy);
				this.bots.push(bot);

				try {
					await bot.login();
				} catch (err) {
					this.log.error(`[${account.username}] Login failed: ${err.message}`);
				}
			});

			await Promise.all(promises);
			this.emit('statusUpdate', this.status);
		}

		const gcReady = this.bots.filter(b => b.state === 'gc_ready').length;
		this.log.success(`${gcReady}/${this._accounts.length} bots GC ready`);
		this.emit('statusUpdate', this.status);
	}

	async startBot(username) {
		const existing = this.bots.find(b => b.username === username);
		if (existing && existing.state !== 'offline' && existing.state !== 'error') {
			return { success: false, error: 'Bot zaten aktif' };
		}

		const account = this._accounts.find(a => a.username === username);
		if (!account) return { success: false, error: 'Hesap bulunamadı' };

		if (existing) {
			existing.disconnect();
			this.bots = this.bots.filter(b => b !== existing);
		}

		const idx = this._accounts.indexOf(account);
		const proxy = this._getProxyForBot(idx);
		const bot = new Bot(account, this.log, proxy);
		this.bots.push(bot);

		try {
			await bot.login();
			await this._withRcon(async (rcon, serverSteamID) => {
				await bot.joinServer(rcon, serverSteamID);
			});
			this.emit('statusUpdate', this.status);
			return { success: true, state: bot.state };
		} catch (err) {
			this.emit('statusUpdate', this.status);
			return { success: false, error: err.message };
		}
	}

	async stopBot(username) {
		const bot = this.bots.find(b => b.username === username);
		if (!bot) return { success: false, error: 'Bot bulunamadı' };
		bot.disconnect();
		this.bots = this.bots.filter(b => b !== bot);
		this.emit('statusUpdate', this.status);
		return { success: true };
	}

	async reconnectBot(username) {
		const bot = this.bots.find(b => b.username === username);
		if (!bot) return { success: false, error: 'Bot bulunamadı' };

		bot.disconnect();
		bot._reconnectAttempts++;
		this._stats.totalReconnects++;

		try {
			await bot.login();
			await this._withRcon(async (rcon, serverSteamID) => {
				await bot.joinServer(rcon, serverSteamID);
			});
			this.emit('statusUpdate', this.status);
			return { success: true, state: bot.state };
		} catch (err) {
			this.emit('statusUpdate', this.status);
			return { success: false, error: err.message };
		}
	}

	async reconnectAllFailed() {
		const failedBots = this.bots.filter(b => b.state === 'error');
		const results = [];
		for (const bot of failedBots) {
			const result = await this.reconnectBot(bot.username);
			results.push({ username: bot.username, ...result });
		}
		return results;
	}

	addAccount(account) {
		if (this._accounts.find(a => a.username === account.username)) {
			return { success: false, error: 'Hesap zaten mevcut' };
		}
		this._accounts.push(account);
		this._saveAccounts();
		return { success: true, total: this._accounts.length };
	}

	removeAccount(username) {
		const bot = this.bots.find(b => b.username === username);
		if (bot) {
			bot.disconnect();
			this.bots = this.bots.filter(b => b !== bot);
		}
		this._accounts = this._accounts.filter(a => a.username !== username);
		this._saveAccounts();
		return { success: true, total: this._accounts.length };
	}

	getAccounts() {
		return this._accounts.map(a => ({
			username: a.username,
			hasSecret: !!(a.sharedSecret && a.sharedSecret.length > 5),
			botState: this.bots.find(b => b.username === a.username)?.state || 'not_started'
		}));
	}

	_saveAccounts() {
		try {
			const filePath = path.join(__dirname, '..', 'accounts.json');
			fs.writeFileSync(filePath, JSON.stringify(this._accounts, null, 2), 'utf8');
		} catch (err) {
			this.log.error(`accounts.json kaydedilemedi: ${err.message}`);
		}
	}

	getAvailableBotsForTarget(targetAccountId) {
		const cached = this._commendCache.get(targetAccountId) || new Set();
		const now = Date.now();
		return this._accounts.filter(a =>
			!cached.has(a.username) &&
			!this._busyAccounts.has(a.username) &&
			!this._isBotInCooldown(a.username, now)
		);
	}

	// Backs off accounts that keep failing: longer pauses for consecutive
	// failures (capped at 15 min), 5 min for a poor overall success rate,
	// 1 min after a single failure.
	_isBotInCooldown(username, now) {
		if (!this._botFailures) return false;
		const f = this._botFailures.get(username);
		if (!f) return false;

		if (f.consecutiveFails >= 3) {
			const cooldownMs = Math.min(f.consecutiveFails * 90000, 15 * 60 * 1000);
			return (now - f.lastFailTime) < cooldownMs;
		}

		const totalAttempts = f.totalFails + f.totalSuccess;
		if (totalAttempts >= 3 && f.totalFails / totalAttempts >= 0.5) {
			return (now - f.lastFailTime) < 5 * 60 * 1000;
		}

		if (f.consecutiveFails >= 1) {
			return (now - f.lastFailTime) < 60 * 1000;
		}

		return false;
	}

	_recordBotResult(username, success) {
		let f = this._botFailures.get(username);
		if (!f) {
			f = { consecutiveFails: 0, totalFails: 0, totalSuccess: 0, lastFailTime: 0 };
			this._botFailures.set(username, f);
		}
		if (success) {
			f.consecutiveFails = 0;
			f.totalSuccess++;
		} else {
			f.consecutiveFails++;
			f.totalFails++;
			f.lastFailTime = Date.now();
		}
	}

	getBotPoolHealth() {
		if (!this._botFailures) return { tracked: 0, inCooldown: 0, problematic: [] };
		const now = Date.now();
		let inCooldown = 0;
		const problematic = [];
		for (const [username, f] of this._botFailures) {
			const isCooldown = this._isBotInCooldown(username, now);
			if (isCooldown) inCooldown++;
			if (f.consecutiveFails >= 3) {
				problematic.push({
					username,
					consecutiveFails: f.consecutiveFails,
					totalFails: f.totalFails,
					totalSuccess: f.totalSuccess,
					inCooldown: isCooldown,
					failRate: f.totalFails / Math.max(1, f.totalFails + f.totalSuccess)
				});
			}
		}
		return {
			tracked: this._botFailures.size,
			inCooldown,
			problematic: problematic.sort((a, b) => b.consecutiveFails - a.consecutiveFails).slice(0, 50)
		};
	}

	async _doSingleCommend(account, targetAccountId, commendTypes, serverSteamID, proxy, op) {
		const accountIndex = this._accounts.indexOf(account);
		if (accountIndex === -1) {
			return { success: false, account: account.username, error: 'Account not found in pool' };
		}

		const sid = new SteamID();
		sid.universe = 1;
		sid.type = 1;
		sid.instance = 1;
		sid.accountid = targetAccountId;
		const targetSteamID64 = sid.getSteamID64();

		const scriptPath = path.join(__dirname, '..', 'commend-single.js');

		if (!proxy) proxy = this._getProxyForBot(accountIndex);

		const args = [scriptPath, targetSteamID64, String(accountIndex)];
		if (serverSteamID) args.push(serverSteamID);

		const childEnv = { ...process.env };
		if (proxy) {
			childEnv.COMMEND_PROXY = proxy;
			// Some HTTP proxies break SNI and Steam's certificate check fails. Verification
			// stays on unless the operator explicitly opts out for such proxies.
			if (this._proxyInsecureTls) childEnv.NODE_TLS_REJECT_UNAUTHORIZED = '0';
		}

		await this._acquireChildSlot();

		return new Promise((resolve) => {
			let slotReleased = false;
			const releaseSlotOnce = () => {
				if (slotReleased) return;
				slotReleased = true;
				this._releaseChildSlot();
			};

			let child;
			try {
				child = spawn(process.execPath, args, {
					cwd: path.join(__dirname, '..'),
					stdio: ['ignore', 'pipe', 'pipe'],
					env: childEnv
				});
			} catch (err) {
				releaseSlotOnce();
				resolve({ success: false, account: account.username, error: `spawn failed: ${err.message}` });
				return;
			}

			if (op) op.activeChildren.add(child);

			let stdout = '';
			let stderr = '';
			let settled = false;

			child.stdout.on('data', (data) => {
				const text = data.toString();
				stdout += text;
				text.split('\n').forEach(line => {
					line = line.trim();
					if (!line || line.startsWith('__RESULT__')) return;
					const cleaned = line.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '');
					if (!cleaned) return;
					if (cleaned.includes('')) {
						this.log.info(cleaned);
					}
				});
			});

			child.stderr.on('data', (data) => {
				const text = data.toString();
				const filtered = text
					.split('\n')
					.filter(l =>
						!/NODE_TLS_REJECT_UNAUTHORIZED/.test(l) &&
						!/Setting the NODE_TLS/.test(l) &&
						!/Use `node --trace-warnings`/.test(l) &&
						!/^\(node:\d+\)\s*Warning:/.test(l)
					)
					.join('\n');
				if (filtered) stderr += filtered;
			});

			child.on('exit', (code) => {
				if (op) op.activeChildren.delete(child);
				releaseSlotOnce();
				if (settled) return;
				settled = true;

				const resultMatch = stdout.match(/__RESULT__(.+)/);
				if (resultMatch) {
					try {
						resolve(JSON.parse(resultMatch[1]));
						return;
					} catch {}
				}

				if (code === 0) {
					resolve({ success: true, account: account.username });
				} else {
					const errMsg = stderr.trim() || `Process exited with code ${code}`;
					resolve({ success: false, account: account.username, error: errMsg });
				}
			});

			child.on('error', (err) => {
				releaseSlotOnce();
				if (settled) return;
				settled = true;
				resolve({ success: false, account: account.username, error: err.message });
			});

			const killTimer = setTimeout(() => {
				if (settled) return;
				settled = true;
				killChildAndFreeLock(child, this.log);
				releaseSlotOnce();
				resolve({ success: false, account: account.username, error: 'Process timeout (120s)' });
			}, 120000);

			child.on('exit', () => clearTimeout(killTimer));
		});
	}

	cancelCommendPlayer(targetAccountId) {
		const key = String(targetAccountId);
		if (this._activeCommendOps && this._activeCommendOps.has(key)) {
			const op = this._activeCommendOps.get(key);
			op.cancelled = true;
			const killedCount = op.activeChildren.size;
			for (const child of op.activeChildren) {
				killChildAndFreeLock(child, this.log);
			}
			op.activeChildren.clear();
			try { if (fs.existsSync(RCON_LOCK_FILE)) fs.unlinkSync(RCON_LOCK_FILE); } catch {}
			this.log.warn(`İşlem iptal edildi: target=${targetAccountId}, ${killedCount} child process öldürüldü, RCON lock serbest`);
		}
	}

	// Runs one order: picks accounts that have not commended this target yet
	// (least used first), then runs commend-single.js children through a
	// pipeline of pipelineSize parallel slots, staggered and throttled by the
	// pipeline config. Can be cancelled through options.isCancelled.
	async commendPlayer(targetAccountId, options = {}) {
		const count = options.count || 1;
		const commendTypes = {
			friendly: options.friendly !== false,
			teaching: options.teaching !== false,
			leader: options.leader !== false
		};
		let success = 0;
		let fail = 0;

		if (!this._activeCommendOps) this._activeCommendOps = new Map();
		const opKey = String(targetAccountId);
		const op = { cancelled: false, activeChildren: new Set() };
		this._activeCommendOps.set(opKey, op);

		const checkCancelled = () => {
			if (op.cancelled) {
				this.log.warn(`İşlem iptal edildi (target=${targetAccountId}), durduruluyor...`);
				return true;
			}
			if (options.isCancelled && options.isCancelled()) {
				op.cancelled = true;
				const killedCount = op.activeChildren.size;
				for (const child of op.activeChildren) {
					killChildAndFreeLock(child, this.log);
				}
				op.activeChildren.clear();
				try { if (fs.existsSync(RCON_LOCK_FILE)) fs.unlinkSync(RCON_LOCK_FILE); } catch {}
				this.log.warn(`İşlem transaction tarafından iptal edildi (target=${targetAccountId}, ${killedCount} child öldürüldü, lock serbest)`);
				return true;
			}
			return false;
		};

		if (!this._commendCache.has(targetAccountId)) {
			this._commendCache.set(targetAccountId, new Set());
		}
		const successCache = this._commendCache.get(targetAccountId);

		let serverSteamID = this._cachedServerSteamID;
		if (!serverSteamID || Date.now() - this._cachedServerSteamIDTime > 300000) {
			try {
				const rcon = new Rcon(this._rconIp, parseInt(this._serverPort), this._rconPassword);
				await rcon.connect();
				const status = await rcon.execute('status');
				rcon.disconnect();
				serverSteamID = parseServerSteamID(status);
				if (serverSteamID) {
					const v = validateServerSteamID(serverSteamID);
					if (!v.valid) {
						this.log.error(`KRİTİK: ${v.reason}`);
						return { success: 0, fail: count, error: v.reason };
					}
					this._cachedServerSteamID = serverSteamID;
					this._cachedServerSteamIDTime = Date.now();
					this.log.info(`Server SteamID: ${serverSteamID}`);
				}
			} catch (err) {
				this.log.warn(`Server SteamID alınamadı: ${err.message} — child'lar kendi alacak`);
			}
		}

		const lockFile = path.join(__dirname, '..', '.rcon.lock');
		try { fs.unlinkSync(lockFile); } catch {}

		const accountsToUse = [];

		const eligible = [];
		for (const acc of this._accounts) {
			if (successCache.has(acc.username)) continue;
			if (this._busyAccounts.has(acc.username)) continue;
			eligible.push(acc);
		}

		if (eligible.length === 0) {
			this.log.warn(`Havuzda bu hedefe uygun hesap kalmadı (${successCache.size}/${this._accounts.length} kullanıldı)`);
			return { success: 0, fail: count };
		}

		eligible.sort((a, b) => {
			const ua = this._botUsageCount.get(a.username) || 0;
			const ub = this._botUsageCount.get(b.username) || 0;
			if (ua !== ub) return ua - ub;
			return Math.random() - 0.5;
		});

		for (const acc of eligible) {
			if (accountsToUse.length >= count) break;
			accountsToUse.push(acc);
			this._busyAccounts.add(acc.username);
			this._botUsageCount.set(acc.username, (this._botUsageCount.get(acc.username) || 0) + 1);
		}

		if (accountsToUse.length > 0) {
			const usages = accountsToUse.map(a => this._botUsageCount.get(a.username) || 0);
			const minU = Math.min(...usages);
			const maxU = Math.max(...usages);
			const eligibleMaxIdx = this._accounts.length - 1;
			const firstIdx = this._accounts.indexOf(accountsToUse[0]);
			const lastIdx = this._accounts.indexOf(accountsToUse[accountsToUse.length - 1]);
			this.log.info(`Bot seçimi: ${accountsToUse.length} hesap, usage ${minU}-${maxU}, havuz idx ${firstIdx}…${lastIdx} (havuz max ${eligibleMaxIdx})`);
		}

		if (accountsToUse.length === 0) {
			this.log.warn(`Havuzda bu hedefe uygun hesap kalmadı (${successCache.size}/${this._accounts.length} kullanıldı)`);
			return { success: 0, fail: count };
		}

		if (accountsToUse.length < count) {
			this.log.warn(`İstenen ${count} commend, uygun ${accountsToUse.length} hesap var`);
		}

		if (!this._proxyCounter) this._proxyCounter = 0;

		const getNextProxy = () => {
			if (this._proxies.length === 0) return null;
			const proxy = this._proxies[this._proxyCounter % this._proxies.length];
			this._proxyCounter++;
			return proxy;
		};

		const PIPELINE_SIZE = this._pipelineConfig.pipelineSize;
		const STAGGER_MS = this._pipelineConfig.staggerMs;
		const MAX_CONSECUTIVE_FAILS = this._pipelineConfig.maxConsecutiveFails;
		const THROTTLE_EVERY = this._pipelineConfig.throttleEvery;
		const THROTTLE_MS = this._pipelineConfig.throttleMs;

		let completed = 0;
		let consecutiveFails = 0;
		let stopPipeline = false;

		let successSinceCooldown = 0;

		for (let batchStart = 0; batchStart < accountsToUse.length; batchStart += PIPELINE_SIZE) {
			if (checkCancelled() || stopPipeline) break;

			if (successSinceCooldown >= THROTTLE_EVERY) {
				this.log.info(`Proaktif GC cooldown: ${successSinceCooldown} başarılı commend sonrası ${Math.round(THROTTLE_MS/1000)}s bekleme (rate-limit önleme)`);
				const cooldownStart = Date.now();
				while (Date.now() - cooldownStart < THROTTLE_MS) {
					if (checkCancelled() || stopPipeline) break;
					await wait(1000);
				}
				successSinceCooldown = 0;
				if (checkCancelled() || stopPipeline) break;
			}

			const batchEnd = Math.min(batchStart + PIPELINE_SIZE, accountsToUse.length);
			const batchAccounts = accountsToUse.slice(batchStart, batchEnd);

			const promises = batchAccounts.map((account, j) => {
				const proxy = getNextProxy();
				return (async () => {
					if (j > 0) await wait(j * STAGGER_MS);
					if (checkCancelled() || stopPipeline) {
						return { success: false, account: account.username, error: 'cancelled' };
					}
					return this._doSingleCommend(account, targetAccountId, commendTypes, serverSteamID, proxy, op);
				})().then(result => {
					this._busyAccounts.delete(account.username);
					if (result && result.invalidAccount) {
						try {
							this._purgeInvalidAccount(account.username, result.error || `eresult=${result.eresult}`);
						} catch (e) {
							this.log.warn(`Invalid account purge hatası: ${e.message}`);
						}
					}
					completed++;
					if (result.success) {
						success++;
						consecutiveFails = 0;
						successSinceCooldown++;
						this._stats.totalSuccess++;
						successCache.add(result.account);
						this._recordBotResult(result.account, true);
						try { require('./lib/metrics').recordCommendAttempt('success', null); } catch {}
						const cat = result.category || 'success';
						const code = result.response_result;
						const tk = result.tokens;
						if (cat === 'ack_no_result' && (tk === 0 || tk === null)) {
							this.log.warn(`[${completed}/${accountsToUse.length}] ${result.account} ✓⚠ ack_no_result tokens=0 (already_commended silent swallow?)`);
							this._stats.suspectSwallow = (this._stats.suspectSwallow || 0) + 1;
						} else if (cat === 'ack_no_result') {
							this.log.info(`[${completed}/${accountsToUse.length}] ${result.account} ✓ ack_no_result (tk=${tk})`);
						} else {
							this.log.info(`[${completed}/${accountsToUse.length}] ${result.account} ✓ result=${code} (tk=${tk})`);
						}
					} else if (result.acked) {
						fail++;
						consecutiveFails++;
						this._stats.totalFail++;
						const cat = result.category || 'failed';
						const code = result.response_result;
						try { require('./lib/metrics').recordCommendAttempt('fail', cat); } catch {}
						if (cat === 'rate_limited') {
							this.log.warn(`[${completed}/${accountsToUse.length}] ${result.account} ✗ rate-limited (5dk cooldown) result=${code}`);
						} else if (cat === 'already_commended') {
							this.log.info(`[${completed}/${accountsToUse.length}] ${result.account} ✗ zaten övdü result=${code}`);
						} else if (cat === 'target_not_found') {
							this.log.warn(`[${completed}/${accountsToUse.length}] ${result.account} ✗ hedef bulunamadı result=${code}`);
						} else {
							this._recordBotResult(result.account, false);
							this.log.warn(`[${completed}/${accountsToUse.length}] ${result.account} ✗ ${cat} result=${code}`);
						}
					} else {
						fail++;
						consecutiveFails++;
						this._stats.totalFail++;
						this._recordBotResult(result.account, false);
						try { require('./lib/metrics').recordCommendAttempt('fail', 'timeout'); } catch {}
						this.log.warn(`[${completed}/${accountsToUse.length}] ${result.account} ✗ ${result.error || 'timeout'}`);
					}
					this._stats.totalCommends++;
					if (options.onProgress) {
						options.onProgress({ success, fail, current: completed, total: accountsToUse.length });
					}
					if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
						this.log.error(`${MAX_CONSECUTIVE_FAILS} ardarda başarısız — sistematik sorun, durduruluyor`);
						stopPipeline = true;
					}
					if (completed % 10 === 0) {
						this._saveCommendCache();
						this.log.info(`── İlerleme: ${success}✓ ${fail}✗ / ${completed} toplam (${accountsToUse.length - completed} kalan) ──`);
					}
					return result;
				});
			});

			await Promise.all(promises);
		}

		this._saveCommendCache();
		this.log.info(`Tamamlandı: ${success}✓ ${fail}✗ / ${completed} toplam`);

		for (const a of accountsToUse) {
			this._busyAccounts.delete(a.username);
		}

		try {
			const rcon = new Rcon(this._rconIp, parseInt(this._serverPort), this._rconPassword);
			const cleanupPromise = (async () => {
				await rcon.connect();
				const resp = await rcon.execute('css_auth_clear');
				this.log.info(`Post-TX auth slot temizliği: ${resp.trim() || 'OK'}`);
				rcon.disconnect();
			})();
			await Promise.race([
				cleanupPromise,
				new Promise((_, rej) => setTimeout(() => rej(new Error('cleanup timeout 5s')), 5000))
			]);
		} catch (e) {
			this.log.warn(`Post-TX auth slot temizliği başarısız (yok sayıldı): ${e.message}`);
		}

		this._activeCommendOps.delete(opKey);
		return { success, fail, cancelled: op.cancelled };
	}

	_startHealthMonitor() {
		if (this._healthTimer) clearInterval(this._healthTimer);
		this._healthTimer = setInterval(async () => {
			const failedBots = this.bots.filter(b => b.state === 'error');
			if (failedBots.length === 0) return;

			this.log.info(`Auto-reconnect: ${failedBots.length} bot(s) down`);
			for (const bot of failedBots) {
				if (bot._reconnectAttempts >= 5) continue;
				try {
					bot.disconnect();
					bot._reconnectAttempts++;
					this._stats.totalReconnects++;
					await bot.login();
				} catch {}
			}
			this.emit('statusUpdate', this.status);
		}, this._healthInterval);
		this._healthTimer.unref();
	}

	async runHealthCheck() {
		return this.bots.map(b => b.toJSON());
	}

	async _applyServerSettings() {
		const timeoutPromise = new Promise((_, reject) =>
			setTimeout(() => reject(new Error('RCON timeout (15s)')), 15000)
		);

		try {
			await Promise.race([this._doApplyServerSettings(), timeoutPromise]);
		} catch (err) {
			this.log.warn(`Sunucu ayarları uygulanamadı: ${err.message}`);
		}
	}

	async _doApplyServerSettings() {
		try {
			const rcon = new Rcon(this._rconIp, parseInt(this._serverPort), this._rconPassword);
			await rcon.connect();

			const commands = [
				'mp_autokick 0',
				'mp_humanteam none',
				'mp_warmup_pausetimer 1',
				'mp_warmuptime 999999999',
				'mp_freezetime 0',
				'mp_roundtime 60',
				'mp_roundtime_defuse 60',
				'mp_maxrounds 0',
				'mp_timelimit 0',
				'mp_autoteambalance 0',
				'mp_limitteams 0',
				'sv_hibernate_when_empty 0',
				'mp_friendlyfire 0',
				'bot_kick',
				'bot_quota 0',
			];

			for (const cmd of commands) {
				try { await rcon.execute(cmd); } catch {}
			}

			rcon.disconnect();
			this.log.success('Sunucu ayarları uygulandı (spectator only + AFK kick kapalı)');
		} catch (err) {
			this.log.warn(`Sunucu ayarları uygulanamadı: ${err.message}`);
		}
	}

	async _autoChangeLevel() {
		if (this._mapChangePromise) {
			this.log.info('Harita değişimi zaten devam ediyor, bekleniyor...');
			return this._mapChangePromise;
		}
		this._mapChangePromise = this._doAutoChangeLevel();
		try {
			await this._mapChangePromise;
		} finally {
			this._mapChangePromise = null;
		}
	}

	async _doAutoChangeLevel() {
		const maps = ['de_dust2', 'de_mirage', 'de_inferno', 'de_anubis', 'de_ancient', 'de_nuke', 'de_vertigo', 'de_overpass'];
		try {
			const rcon = new Rcon(this._rconIp, parseInt(this._serverPort), this._rconPassword);
			await rcon.connect();

			let currentMap = '';
			try {
				const status = await rcon.execute('status');
				const mapMatch = status.match(/map\s*:\s*(\S+)/i);
				if (mapMatch) currentMap = mapMatch[1];
			} catch {}

			const candidates = maps.filter(m => m !== currentMap);
			const nextMap = candidates[Math.floor(Math.random() * candidates.length)] || 'de_dust2';

			const oldSteamID = this._cachedServerSteamID;
			this.log.warn(`Otomatik harita değişimi: ${currentMap || '?'} → ${nextMap} (${this._commendsSinceMapChange} commend sonrası GC limit bypass)`);
			await rcon.execute(`changelevel ${nextMap}`);
			rcon.disconnect();

			this._commendsSinceMapChange = 0;
			this._cachedServerSteamID = null;
			this._cachedServerSteamIDTime = 0;

			this.log.info('Harita değişiyor, sunucu hazır olana kadar bekleniyor (20s)...');
			await wait(20000);

			try {
				const rcon2 = new Rcon(this._rconIp, parseInt(this._serverPort), this._rconPassword);
				await rcon2.connect();
				const status2 = await rcon2.execute('status');
				const newSteamID = parseServerSteamID(status2);
				rcon2.disconnect();
				if (newSteamID) {
					const v = validateServerSteamID(newSteamID);
					if (!v.valid) {
						this.log.error(`KRİTİK: Harita değişimi sonrası ${v.reason}`);
					} else {
						if (v.warning) this.log.info(v.warning);
						this._cachedServerSteamID = newSteamID;
						this._cachedServerSteamIDTime = Date.now();

						if (oldSteamID && newSteamID === oldSteamID) {
							this.log.warn(`changelevel sonrası server SteamID değişmedi (${newSteamID}) — GSLT ile SteamID sabit kalır`);
						} else {
							this.log.success(`Yeni server SteamID: ${newSteamID} — GC limiti sıfırlandı`);
						}
					}
				}
			} catch (err) {
				this.log.warn(`Yeni server SteamID alınamadı: ${err.message}`);
			}

			await this._applyServerSettings();
		} catch (err) {
			this.log.error(`Otomatik harita değişimi başarısız: ${err.message}`);
		}
	}

	async getPlayerCommendCount(targetAccountId) {
		const MAX_PROFILE_ATTEMPTS = 1;

		for (let attempt = 1; attempt <= MAX_PROFILE_ATTEMPTS; attempt++) {
			let bot = this.bots.find(b => (b.state === 'gc_ready' || b.state === 'on_server') && b._steam);
			let tempBot = false;

			if (!bot) {
				const account = this._accounts[0];
				if (!account) throw new Error('Hesap havuzu boş');

				bot = new Bot(account, this.log, null);
				tempBot = true;

				try {
					await bot.login();
				} catch (err) {
					bot.disconnect();
					throw new Error(`Profil sorgu botu login başarısız: ${err.message}`);
				}
			}

			try {
				try { await bot.refreshGC(); } catch {}

				const result = await bot.requestPlayerProfile(targetAccountId);
				this.log.info(`Profil sorgusu: friendly=${result.friendly}, teaching=${result.teaching}, leader=${result.leader}`);
				return result;
			} catch (err) {
				if (attempt < MAX_PROFILE_ATTEMPTS) {
					if (tempBot) {
						bot.disconnect();
						this.bots = this.bots.filter(b => b !== bot);
					}
					await wait(3000);
					continue;
				}
				return null;
			} finally {
				if (tempBot) {
					bot.disconnect();
					this.bots = this.bots.filter(b => b !== bot);
				}
			}
		}
		return null;
	}

	async stopAll() {
		this._saveCommendCache();
		this.log.info('Commend cache diske kaydedildi (shutdown)');

		try { await this.stopLogReceiver(); } catch {}

		if (this._healthTimer) {
			clearInterval(this._healthTimer);
			this._healthTimer = null;
		}
		for (const bot of this.bots) bot.disconnect();
		this.bots = [];
		this._cachedServerSteamID = null;
		this.log.info('All bots stopped');
		this.emit('statusUpdate', this.status);
	}
}

module.exports = BotManager;
