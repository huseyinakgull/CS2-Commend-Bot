const EventEmitter = require('events');

class HesapManager extends EventEmitter {
	constructor(opts = {}) {
		super();
		this.config = opts.config || {};
		this.log = opts.log || console;
		this.proxy = opts.proxy || null;

		this._pollIntervalSec = opts.pollIntervalSec || 60;
		this._pollTimer = null;

		this._client = null;

		this.state = 'idle';
		this.lastError = null;
		this.lastAction = null;
		this.lastActionAt = null;
		this.sessionAlive = null;
		this.sessionLastChecked = null;
		this._currentOp = null;
		this._lastPoll = null;
		this._lastPollResults = null;

		this.busy = false;
	}

	getStatus() {
		return {
			state: this.state,
			lastError: this.lastError,
			lastAction: this.lastAction,
			lastActionAt: this.lastActionAt,
			sessionLastChecked: this.sessionLastChecked,
			sessionAlive: this.sessionAlive,
			busy: this.busy,
			currentOp: this._currentOp,
			browserLaunched: !!this._client,
			proxy: this.proxy ? this.proxy.server : null,
			poll: {
				enabled: !!this._pollTimer,
				intervalSec: this._pollIntervalSec,
				lastPoll: this._lastPoll,
				lastResults: this._lastPollResults
			}
		};
	}

	_setState(state, opts = {}) {
		this.state = state;
		this.lastAction = opts.lastAction || this.lastAction;
		this.lastActionAt = new Date().toISOString();
		if ('lastError' in opts) this.lastError = opts.lastError;
		this.emit('statusChanged', this.getStatus());
	}

	_ensureClient() {
		if (this._client) return this._client;
		const { HesapHttpClient } = require('./lib/http-client');
		this._client = new HesapHttpClient({ proxy: this.proxy });
		return this._client;
	}

	async _withMutex(opName, fn) {
		if (this.busy) throw new Error(`busy: ${this._currentOp}`);
		this.busy = true;
		this._currentOp = opName;
		try {
			return await fn();
		} finally {
			this.busy = false;
			this._currentOp = null;
		}
	}

	async login() {
		return this._withMutex('login', async () => {
			this._setState('working', { lastAction: 'login' });
			const client = this._ensureClient();
			const ok = await client.isLoggedIn();
			this.sessionAlive = ok;
			this.sessionLastChecked = new Date().toISOString();
			if (ok) {
				this._setState('ready', { lastError: null });
				return { ok: true, message: 'Cookies geçerli, login OK' };
			} else {
				this._setState('error', { lastError: 'session_expired' });
				return { ok: false, error: 'cookies geçersiz — yeniden export edip storage-state.json güncelle' };
			}
		});
	}

	async check() {
		return this._withMutex('check', async () => {
			this._setState('working', { lastAction: 'check' });
			const client = this._ensureClient();
			const ok = await client.isLoggedIn();
			this.sessionAlive = ok;
			this.sessionLastChecked = new Date().toISOString();
			this._setState(ok ? 'ready' : 'idle', { lastError: ok ? null : 'session_expired' });
			return { loggedIn: ok };
		});
	}

	async stop() {
		return this._withMutex('stop', async () => {
			this._setState('working', { lastAction: 'stop' });
			this._client = null;
			this._setState('idle', { lastError: null });
			return { stopped: true };
		});
	}

	async pollOnce() {
		const { pollOnce } = require('./lib/orders');
		return this._withMutex('poll', async () => {
			this._setState('working', { lastAction: 'poll' });
			const client = this._ensureClient();
			const ok = await client.isLoggedIn();
			if (!ok) {
				this.sessionAlive = false;
				this._setState('error', { lastError: 'session_expired' });
				throw new Error('Session expired — cookies geçersiz, storage-state.json güncelle');
			}
			this.sessionAlive = true;
			this.sessionLastChecked = new Date().toISOString();

			const results = await pollOnce(client, { log: m => this.log.info?.(m) || console.log(m) });
			this._lastPoll = new Date().toISOString();
			this._lastPollResults = results;
			this._setState('ready', { lastError: null });
			return { count: results.length, results };
		});
	}

	async reactivatePassive() {
		const { reactivatePassiveListings } = require('./lib/orders');
		return this._withMutex('reactivate', async () => {
			this._setState('working', { lastAction: 'reactivate' });
			const client = this._ensureClient();
			const ok = await client.isLoggedIn();
			if (!ok) {
				this.sessionAlive = false;
				this._setState('error', { lastError: 'session_expired' });
				throw new Error('Session expired');
			}
			const result = await reactivatePassiveListings(client, {
				log: m => this.log.info?.(m) || console.log(m)
			});
			this._setState('ready', { lastError: null });
			return result;
		});
	}

	startPolling() {
		if (this._pollTimer) return { started: false, alreadyRunning: true, intervalSec: this._pollIntervalSec };
		const intervalMs = Math.max(this._pollIntervalSec * 1000, 30000);
		this.log.info?.(`[hesap] polling başlatıldı (${this._pollIntervalSec}s aralıkla)`);
		this._sessionFailCount = 0;

		const tick = async () => {
			if (this.busy) return;
			try {
				const r = await this.pollOnce();
				this._sessionFailCount = 0;
				if (r.count > 0) {
					this.log.info?.(`[hesap] poll: ${r.count} sipariş işlendi`);
				}
			} catch (err) {
				const msg = err.message || String(err);
				const isSessionExpired = /session expired|cookies/i.test(msg);
				if (isSessionExpired) {
					this._sessionFailCount = (this._sessionFailCount || 0) + 1;
					if (this._sessionFailCount >= 3) {
						this.log.warn?.(`[hesap] ⚠ ${this._sessionFailCount} ardışık session_expired — polling DURDURULDU. Cookies'i yenile.`);
						this.stopPolling();
						return;
					}
					this.log.warn?.(`[hesap] ⚠ oturum gerekli (${this._sessionFailCount}/3 — devam)`);
				} else {
					this.log.warn?.(`[hesap] poll hatası: ${msg}`);
				}
			}
		};
		setTimeout(tick, 8000);
		this._pollTimer = setInterval(tick, intervalMs);
		this.emit('statusChanged', this.getStatus());
		return { started: true, intervalSec: this._pollIntervalSec };
	}

	stopPolling() {
		if (!this._pollTimer) return { running: false };
		clearInterval(this._pollTimer);
		this._pollTimer = null;
		this.log.info?.('[hesap] polling durduruldu');
		this.emit('statusChanged', this.getStatus());
		return { stopped: true };
	}

	async shutdown() {
		if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
		this._client = null;
	}
}

module.exports = { HesapManager };
