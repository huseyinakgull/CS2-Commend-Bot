const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const EventEmitter = require('events');
const db = require('./database');
const { decryptJson } = require('./lib/crypto-util');

const TICK_INTERVAL_MS = 60 * 1000;
const RECONNECT_MIN_DELAY = 15 * 1000;
const RECONNECT_MAX_DELAY = 5 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 45 * 1000;

class HoursSession extends EventEmitter {
	constructor(row, logger, cryptoSecret) {
		super();
		this.id = row.id;
		this.userId = row.user_id;
		this.username = row.steam_username;
		this.appid = row.appid || 730;
		this.requestedHours = row.requested_hours;
		this.hoursDone = row.hours_done || 0;
		this.encryptedBlob = row.credential_blob;
		this.status = row.status;
		this.log = logger;
		this.cryptoSecret = cryptoSecret;

		this._steam = null;
		this._tickTimer = null;
		this._reconnectTimer = null;
		this._reconnectDelay = RECONNECT_MIN_DELAY;
		this._stopped = false;
		this._loggedOn = false;
	}

	get progressPercent() {
		if (!this.requestedHours) return 0;
		return Math.min(100, Math.round((this.hoursDone / this.requestedHours) * 1000) / 10);
	}

	toJSON() {
		return {
			id: this.id,
			username: this.username,
			appid: this.appid,
			requestedHours: this.requestedHours,
			hoursDone: Number(this.hoursDone.toFixed(2)),
			status: this.status,
			progressPercent: this.progressPercent,
		};
	}

	async start() {
		if (this.status === 'completed' || this.status === 'cancelled') return;
		this._stopped = false;

		let creds;
		try {
			creds = decryptJson(this.encryptedBlob, this.cryptoSecret);
		} catch (err) {
			this.log.error(`[hours #${this.id}] credential decrypt failed: ${err.message}`);
			this._setStatus('failed', 'credential_decrypt_failed');
			return;
		}

		this._connect(creds);
	}

	_connect(creds) {
		if (this._stopped) return;

		const steamOpts = { autoRelogin: false };
		this._steam = new SteamUser(steamOpts);

		const onError = (err) => {
			this.log.warn(`[hours #${this.id}] steam error: ${err.message}`);
			this._teardownSteam();
			if (this._stopped) return;

			const msg = (err.message || '').toLowerCase();
			const hasSS = !!(creds.sharedSecret && creds.sharedSecret.length > 5);

			if (msg.includes('invalidpassword')) {
				const friendly = hasSS
					? 'Şifre yanlış veya hesap kilitli. Steam\'de tekrar giriş yapıp şifreyi doğrulayın.'
					: 'Giriş başarısız. Hesabınızda Steam Guard Mobile aktifse "Shared Secret" girmek zorundasınız (SDA — Steam Desktop Authenticator ile export). Aksi halde şifrenizi kontrol edin.';
				this._setStatus('failed', friendly);
				this.emit('statusChanged');
				return;
			}
			if (msg.includes('accountlocked') || msg.includes('accountlockedout')) {
				this._setStatus('failed', 'Hesap geçici kilitli — çok fazla başarısız giriş denemesi. 15-30 dakika bekleyin ve tekrar deneyin.');
				this.emit('statusChanged');
				return;
			}
			if (msg.includes('twofactorcode') || msg.includes('invalidloginauthcode')) {
				this._setStatus('failed', 'Steam Guard kodu reddedildi. Shared Secret değerinin doğruluğunu kontrol edin (SDA → maFile içinden export).');
				this.emit('statusChanged');
				return;
			}
			if (msg.includes('ratelimit') || msg.includes('rate_limit')) {
				this._setStatus('failed', 'Steam IP rate-limit. Birkaç saat sonra tekrar deneyin veya hesabı farklı IP\'den deneyin.');
				this.emit('statusChanged');
				return;
			}
			if (msg.includes('logon_session_replaced') || msg.includes('logged_in_elsewhere')) {
				this.log.info(`[hours #${this.id}] logon replaced (başka cihazda giriş yapıldı), retry`);
			}

			this._scheduleReconnect(creds);
		};

		this._steam.on('error', onError);

		this._steam.on('loggedOn', () => {
			this._loggedOn = true;
			this._reconnectDelay = RECONNECT_MIN_DELAY;
			try {
				const sid64 = this._steam.steamID.getSteamID64();
				db.prepare('UPDATE hours_boost_sessions SET steam_id64 = ?, status = ?, started_at = COALESCE(started_at, datetime(\'now\')) WHERE id = ?')
					.run(sid64, 'running', this.id);
				this.status = 'running';
			} catch (e) {
				this.log.warn(`[hours #${this.id}] db update on login: ${e.message}`);
			}
			this._steam.setPersona(SteamUser.EPersonaState.Online);
			this._steam.gamesPlayed([this.appid]);
			this._startTicker();
			this.emit('statusChanged');
			this.log.success(`[hours #${this.id}] ${this.username} logged on, idling ${this.appid}`);
		});

		this._steam.on('accountInfo', (name) => {
			try {
				db.prepare('UPDATE hours_boost_sessions SET steam_persona = ? WHERE id = ?').run(name, this.id);
			} catch {}
		});

		this._steam.on('disconnected', (eresult, msg) => {
			this.log.info(`[hours #${this.id}] disconnected (${msg || eresult})`);
			this._loggedOn = false;
			this._stopTicker();
			if (this._stopped) return;
			this._scheduleReconnect(creds);
		});

		this._steam.on('playingState', (blocked) => {
			if (blocked) {
				this.log.warn(`[hours #${this.id}] family-share / other login took over, stopping`);
				this._setStatus('failed', 'session_taken_over');
				this.stop();
				this.emit('statusChanged');
			}
		});

		let twoFactorCode;
		try {
			twoFactorCode = (creds.sharedSecret && creds.sharedSecret.length > 5)
				? SteamTotp.getAuthCode(creds.sharedSecret)
				: undefined;
		} catch (e) {
			this.log.error(`[hours #${this.id}] sharedSecret parse error: ${e.message}`);
			this._setStatus('failed', 'invalid_shared_secret');
			return;
		}

		const loginTimeout = setTimeout(() => {
			try { this._steam.logOff(); } catch {}
			onError(new Error('login_timeout'));
		}, LOGIN_TIMEOUT_MS);

		this._steam.once('loggedOn', () => clearTimeout(loginTimeout));

		try {
			this._steam.logOn({
				accountName: creds.username,
				password: creds.password,
				twoFactorCode
			});
		} catch (err) {
			clearTimeout(loginTimeout);
			onError(err);
		}
	}

	_teardownSteam() {
		if (!this._steam) return;
		try { this._steam.removeAllListeners(); } catch {}
		try { this._steam.logOff(); } catch {}
		this._steam = null;
	}

	_scheduleReconnect(creds) {
		if (this._stopped) return;
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = null;
		}
		const delay = this._reconnectDelay;
		this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_DELAY);
		this.log.info(`[hours #${this.id}] reconnecting in ${Math.round(delay / 1000)}s`);
		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = null;
			if (this._stopped) return;
			this._connect(creds);
		}, delay);
	}

	_startTicker() {
		this._stopTicker();
		this._tickTimer = setInterval(() => this._tick(), TICK_INTERVAL_MS);
	}

	_stopTicker() {
		if (this._tickTimer) {
			clearInterval(this._tickTimer);
			this._tickTimer = null;
		}
	}

	_tick() {
		if (!this._loggedOn) return;
		this.hoursDone = Math.min(this.requestedHours, this.hoursDone + (TICK_INTERVAL_MS / 3600000));
		try {
			db.prepare('UPDATE hours_boost_sessions SET hours_done = ?, last_tick = datetime(\'now\') WHERE id = ?')
				.run(this.hoursDone, this.id);
		} catch (e) {
			this.log.warn(`[hours #${this.id}] tick db update: ${e.message}`);
		}
		this.emit('progress');
		if (this.hoursDone >= this.requestedHours) {
			this.log.success(`[hours #${this.id}] target reached (${this.requestedHours}h)`);
			this._setStatus('completed');
			this.emit('statusChanged');
			this.stop();
		}
	}

	_setStatus(status, errorMsg) {
		this.status = status;
		if (status === 'completed' || status === 'failed' || status === 'cancelled') {
			this._stopped = true;
			if (this._reconnectTimer) {
				clearTimeout(this._reconnectTimer);
				this._reconnectTimer = null;
			}
			this._stopTicker();
			this._teardownSteam();
		}
		try {
			db.prepare(`
				UPDATE hours_boost_sessions
				SET status = ?,
				    last_error = ?,
				    completed_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN datetime('now') ELSE completed_at END
				WHERE id = ?
			`).run(status, errorMsg || null, status, this.id);
		} catch (e) {
			this.log.warn(`[hours #${this.id}] set status: ${e.message}`);
		}
	}

	stop(reason = 'user_stopped') {
		this._stopped = true;
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = null;
		}
		this._stopTicker();
		this._teardownSteam();
		if (this.status === 'running' || this.status === 'pending') {
			this._setStatus('cancelled', reason);
			this.emit('statusChanged');
		}
	}
}

class HoursBoostManager extends EventEmitter {
	constructor(logger, opts = {}) {
		super();
		this.log = logger;
		this.cryptoSecret = opts.cryptoSecret;
		this._sessions = new Map();
		this._sseClients = new Set();
	}

	async resumeAll() {
		const rows = db.prepare(`
			SELECT * FROM hours_boost_sessions
			WHERE status IN ('pending', 'running')
			ORDER BY id ASC
		`).all();

		for (const row of rows) {
			this._spawnSession(row);
		}
		this.log.info(`[hours] ${rows.length} aktif session resume edildi`);
	}

	_spawnSession(row) {
		if (this._sessions.has(row.id)) return this._sessions.get(row.id);
		const session = new HoursSession(row, this.log, this.cryptoSecret);
		this._sessions.set(row.id, session);
		session.on('statusChanged', () => this._broadcast({ type: 'hoursStatus', data: session.toJSON(), userId: row.user_id }));
		session.on('progress', () => this._broadcast({ type: 'hoursProgress', data: session.toJSON(), userId: row.user_id }));
		session.start().catch(err => this.log.error(`[hours #${row.id}] start failed: ${err.message}`));
		return session;
	}

	startFromRow(row) {
		return this._spawnSession(row);
	}

	stopSession(id, reason = 'user_stopped') {
		const session = this._sessions.get(id);
		const refund = (() => {
			const row = db.prepare('SELECT requested_hours, hours_done, status FROM hours_boost_sessions WHERE id = ?').get(id);
			if (!row) return 0;
			if (row.status === 'completed' || row.status === 'cancelled' || row.status === 'failed') return 0;
			return Math.max(0, Math.floor(row.requested_hours - row.hours_done));
		})();
		if (session) session.stop(reason);
		return refund;
	}

	getSession(id) {
		return this._sessions.get(id) || null;
	}

	listUserSessions(userId) {
		return db.prepare(`
			SELECT id, steam_username, steam_persona, steam_id64, appid,
			       requested_hours, hours_done, status, last_error,
			       started_at, last_tick, completed_at, created_at
			FROM hours_boost_sessions
			WHERE user_id = ?
			ORDER BY id DESC
		`).all(userId);
	}

	addSSEClient(res, userId) {
		const entry = { res, userId };
		this._sseClients.add(entry);
		res.on('close', () => this._sseClients.delete(entry));
	}

	_broadcast(payload) {
		const json = JSON.stringify(payload);
		for (const { res, userId } of this._sseClients) {
			if (userId && payload.userId && userId !== payload.userId) continue;
			try {
				res.write(`data: ${json}\n\n`);
			} catch {}
		}
		this.emit('event', payload);
	}

	async shutdownAll() {
		for (const session of this._sessions.values()) {
			try { session.stop('service_shutdown'); } catch {}
		}
		this._sessions.clear();
	}
}

module.exports = HoursBoostManager;
module.exports.HoursSession = HoursSession;
