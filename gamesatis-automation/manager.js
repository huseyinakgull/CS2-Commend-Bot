const EventEmitter = require('events');

class GamesatisManager extends EventEmitter {
	constructor(logger) {
		super();
		this.log = logger;
		this.state = 'idle';
		this.lastError = null;
		this.lastAction = null;
		this.lastActionAt = null;
		this.sessionLastChecked = null;
		this.sessionAlive = null;
		this.busy = false;
		this._browser = null;
		this._heartbeat = null;
		this._currentOp = null;
		this._pollTimer = null;
		this._pollIntervalSec = parseInt(process.env.GAMESATIS_POLL_INTERVAL_SEC || '60', 10);
		this._lastPoll = null;
		this._lastPollResults = null;
	}

	getStatus() {
		const orderState = require('./lib/order-state');
		return {
			state: this.state,
			lastError: this.lastError,
			lastAction: this.lastAction,
			lastActionAt: this.lastActionAt,
			sessionLastChecked: this.sessionLastChecked,
			sessionAlive: this.sessionAlive,
			busy: this.busy,
			currentOp: this._currentOp,
			browserLaunched: !!this._browser,
			email: process.env.GAMESATIS_EMAIL || null,
			internalTokenSet: !!process.env.CSCOMMENDS_INTERNAL_TOKEN,
			headless: (process.env.GAMESATIS_HEADLESS === 'true'),
			poll: {
				enabled: !!this._pollTimer,
				intervalSec: this._pollIntervalSec,
				lastPoll: this._lastPoll,
				lastResults: this._lastPollResults
			},
			orderStats: orderState.getStats()
		};
	}

	_setState(state, opts = {}) {
		this.state = state;
		if ('lastError' in opts) this.lastError = opts.lastError;
		if ('lastAction' in opts) {
			this.lastAction = opts.lastAction;
			this.lastActionAt = new Date().toISOString();
		}
		this.emit('statusChanged', this.getStatus());
		this.log.info(`[gamesatis] state=${state}${opts.lastAction ? ' action=' + opts.lastAction : ''}${opts.lastError ? ' err=' + opts.lastError : ''}`);
	}

	async _ensureBrowser() {
		if (this._browser) return this._browser;
		const { GamesatisBrowser } = require('./lib/browser');
		this._browser = new GamesatisBrowser();
		await this._browser.launch();
		return this._browser;
	}

	async _withMutex(opName, fn) {
		if (this.busy) {
			throw new Error(`Başka işlem devam ediyor: ${this._currentOp}`);
		}
		this.busy = true;
		this._currentOp = opName;
		this.emit('statusChanged', this.getStatus());
		try {
			return await fn();
		} finally {
			this.busy = false;
			this._currentOp = null;
			this.emit('statusChanged', this.getStatus());
		}
	}

	async _afterLoginSuccess() {
		if (!this._pollTimer) {
			this.log.info('[gamesatis] login OK — polling otomatik başlatılıyor');
			this.startPolling();
			this._notifyDiscord('🟢 Gamesatis login başarılı — polling resume edildi');
		}
	}

	async login() {
		const email = process.env.GAMESATIS_EMAIL;
		const password = process.env.GAMESATIS_PASSWORD;
		if (!email || !password) {
			throw new Error('.env içinde GAMESATIS_EMAIL ve GAMESATIS_PASSWORD tanımlı değil');
		}

		return this._withMutex('login', async () => {
			this._setState('launching', { lastAction: 'login' });
			const browser = await this._ensureBrowser();
			const { login, isLoggedIn } = require('./lib/auth');

			if (await isLoggedIn(browser.page)) {
				this.sessionAlive = true;
				this.sessionLastChecked = new Date().toISOString();
				await browser.saveState();
				this._setState('ready', { lastError: null });
				await this._afterLoginSuccess();
				return { alreadyLoggedIn: true };
			}

			this._setState('working', { lastAction: 'login' });
			try {
				await login(browser.page, { email, password });
				await browser.saveState();
				this.sessionAlive = true;
				this.sessionLastChecked = new Date().toISOString();
				this._setState('ready', { lastError: null });
				await this._afterLoginSuccess();
				return { success: true };
			} catch (err) {
				this._setState('error', { lastError: err.message });
				try { await browser.screenshot('login-error.png', { fullPage: true }); } catch {}
				this._notifyDiscord(`🔴 Gamesatis login fail: ${err.message.slice(0, 200)}`);
				throw err;
			}
		});
	}

	async check() {
		return this._withMutex('check', async () => {
			this._setState('working', { lastAction: 'check' });
			const browser = await this._ensureBrowser();
			const { isLoggedIn } = require('./lib/auth');
			const ok = await isLoggedIn(browser.page);
			this.sessionAlive = ok;
			this.sessionLastChecked = new Date().toISOString();
			this._setState(ok ? 'ready' : 'idle', { lastError: null });
			return { loggedIn: ok };
		});
	}

	async stop() {
		return this._withMutex('stop', async () => {
			this._setState('working', { lastAction: 'stop' });
			if (this._browser) {
				try { await this._browser.close(); } catch (err) {
					this.log.warn(`[gamesatis] browser close error: ${err.message}`);
				}
				this._browser = null;
			}
			this._setState('idle', { lastError: null });
			return { stopped: true };
		});
	}

	async pollOnce() {
		const { isLoggedIn } = require('./lib/auth');
		const { pollOnce } = require('./lib/orders');

		return this._withMutex('poll', async () => {
			this._setState('working', { lastAction: 'poll' });
			const browser = await this._ensureBrowser();
			const ok = await isLoggedIn(browser.page);
			if (!ok) {
				this.sessionAlive = false;
				this._setState('error', { lastError: 'session_expired' });
				throw new Error('Session expired — login gerekli');
			}
			this.sessionAlive = true;
			this.sessionLastChecked = new Date().toISOString();

			const results = await pollOnce(browser.page, { log: m => this.log.info(m) });
			this._lastPoll = new Date().toISOString();
			this._lastPollResults = results;
			this._setState('ready', { lastError: null });
			return { count: results.length, results };
		});
	}

	async scanInbox(opts = {}) {
		const { isLoggedIn } = require('./lib/auth');
		const messagesPerChat = opts.messagesPerChat || 10;
		const maxChats = opts.maxChats || 25;

		return this._withMutex('scan-inbox', async () => {
			this._setState('working', { lastAction: 'scan-inbox' });
			const browser = await this._ensureBrowser();
			const ok = await isLoggedIn(browser.page);
			if (!ok) {
				this.sessionAlive = false;
				this._setState('error', { lastError: 'session_expired' });
				throw new Error('Session expired — login gerekli');
			}
			this.sessionAlive = true;
			this.sessionLastChecked = new Date().toISOString();

			const page = browser.page;
			const log = m => this.log.info(m);

			log('[scan-inbox] /mesajlarim sayfasına gidiliyor...');
			await page.goto('https://www.gamesatis.com/mesajlarim', { waitUntil: 'domcontentloaded', timeout: 30000 });
			await page.waitForTimeout(3000);

			const chatCount = await page.evaluate(() => {
				const candidates = Array.from(document.querySelectorAll('a, div, li')).filter(el => {
					const text = (el.innerText || '').trim();
					return /sipariş\s*numaralı/i.test(text) && text.length < 300;
				});
				const seen = new Set();
				const unique = [];
				for (const el of candidates) {
					const key = (el.innerText || '').substring(0, 50);
					if (seen.has(key)) continue;
					seen.add(key);
					unique.push(el);
				}
				return unique.length;
			});

			log(`[scan-inbox] ${chatCount} sohbet kartı tespit edildi`);

			if (chatCount === 0) {
				this._setState('ready', { lastError: null });
				return { chats: [], note: 'Sohbet kartı bulunamadı' };
			}

			const chats = [];
			const limit = Math.min(chatCount, maxChats);

			for (let i = 0; i < limit; i++) {
				try {
					if (i > 0) {
						await page.goto('https://www.gamesatis.com/mesajlarim', { waitUntil: 'domcontentloaded', timeout: 30000 });
						await page.waitForTimeout(2500);
					}

					const result = await page.evaluate(async ({ index, msgLimit }) => {
						const candidates = Array.from(document.querySelectorAll('a, div, li')).filter(el => {
							const text = (el.innerText || '').trim();
							return /sipariş\s*numaralı/i.test(text) && text.length < 300;
						});
						const seen = new Set();
						const unique = [];
						for (const el of candidates) {
							const key = (el.innerText || '').substring(0, 50);
							if (seen.has(key)) continue;
							seen.add(key);
							unique.push(el);
						}

						const card = unique[index];
						if (!card) return { error: `Index ${index} kart yok` };

						const cardText = (card.innerText || '').trim();
						const customerMatch = cardText.match(/^([A-ZÇĞİÖŞÜ][a-zA-ZçğıöşüÇĞİÖŞÜ\s\.]+)/);
						const orderMatch = cardText.match(/(\d{6,})\s*sipariş/);
						const dateMatch = cardText.match(/(\d{2}\.\d{2}\.\d{4})/);
						const customer = customerMatch ? customerMatch[1].trim() : '?';
						const orderId = orderMatch ? orderMatch[1] : null;
						const date = dateMatch ? dateMatch[1] : null;

						card.scrollIntoView({ block: 'center' });
						const clickable = card.tagName === 'A' ? card : (card.querySelector('a') || card);
						clickable.click();

						await new Promise(r => setTimeout(r, 2500));

						const msgContainers = [
							'.chat-messages', '.message-list', '.conversation', '[class*="ChatMessages"]',
							'[class*="messageList"]', '[class*="MessageList"]'
						];
						let msgArea = null;
						for (const sel of msgContainers) {
							msgArea = document.querySelector(sel);
							if (msgArea) break;
						}
						if (!msgArea) {
							msgArea = document.body;
						}

						let messages = [];
						const msgEls = msgArea.querySelectorAll('[class*="message" i]:not([class*="messageList" i])');
						if (msgEls.length > 0) {
							msgEls.forEach(el => {
								const t = (el.innerText || '').trim();
								if (t && t.length < 1000) messages.push(t);
							});
						}
						if (messages.length === 0) {
							const bodyText = (msgArea.innerText || '');
							const lines = bodyText.split('\n').map(s => s.trim()).filter(Boolean);
							messages = lines.filter(l =>
								l.length > 5 && l.length < 500 &&
								!/^(0|1|765|Mesajlarım|Siparişlerim|Cüzdan|Mağazam|Kuponlarım|Favorilerim|İlanlarım|Hakkımızda|Canlı Destek|Hesap|Ödeme|Çıkış|Yardım|Copyright|İletişim|S\.S\.S\.|Yorumlar|Türkiye|GameSatış)/i.test(l)
							);
						}

						return {
							customer,
							orderId,
							date,
							cardText: cardText.substring(0, 200),
							messages: messages.slice(-msgLimit),
							messageCount: messages.length,
							msgAreaSelector: msgArea === document.body ? '(body fallback)' : (msgArea.className || msgArea.tagName)
						};
					}, { index: i, msgLimit: messagesPerChat });

					chats.push(result);
					log(`[scan-inbox] [${i + 1}/${limit}] ${result.customer || '?'} (#${result.orderId || '?'}) — ${result.messages?.length || 0} mesaj`);
					await page.waitForTimeout(800);
				} catch (err) {
					log(`[scan-inbox] [${i + 1}] hata: ${err.message}`);
					chats.push({ error: err.message, index: i });
				}
			}

			this._setState('ready', { lastError: null });
			return { chats, total: chatCount, scanned: chats.length };
		});
	}

	async reactivateOutOfStock() {
		const { isLoggedIn } = require('./lib/auth');
		const { reactivateOutOfStockListings } = require('./lib/orders');

		return this._withMutex('reactivate', async () => {
			this._setState('working', { lastAction: 'reactivate' });
			const browser = await this._ensureBrowser();
			const ok = await isLoggedIn(browser.page);
			if (!ok) {
				this.sessionAlive = false;
				this._setState('error', { lastError: 'session_expired' });
				throw new Error('Session expired — login gerekli');
			}
			this.sessionAlive = true;
			this.sessionLastChecked = new Date().toISOString();

			const result = await reactivateOutOfStockListings(browser.page, { log: m => this.log.info(m) });
			this._setState('ready', { lastError: null });
			return result;
		});
	}

	startPolling() {
		if (this._pollTimer) return { started: false, alreadyRunning: true, intervalSec: this._pollIntervalSec };
		const intervalMs = Math.max(this._pollIntervalSec * 1000, 30000);
		this.log.info(`[gamesatis] polling başlatıldı (${this._pollIntervalSec}s aralıkla)`);
		this._sessionWarnedAt = 0;
		this._sessionFailCount = 0;

		const tick = async () => {
			if (this.busy) return;
			try {
				const r = await this.pollOnce();
				this._sessionFailCount = 0;
				if (r.count > 0) {
					this.log.info(`[gamesatis] poll: ${r.count} sipariş işlendi`);
					this._notifyDiscord(`✅ Gamesatis: ${r.count} sipariş otomatik işlendi`);
				}
			} catch (err) {
				const msg = err.message || String(err);
				const isSessionExpired = /session expired|session yok|login gerekli|giris-yap|giris/i.test(msg);
				if (isSessionExpired) {
					this._sessionFailCount = (this._sessionFailCount || 0) + 1;
					if (this._sessionFailCount >= 3) {
						this.log.warn(`[gamesatis] ⚠ ${this._sessionFailCount} ardışık session_expired — polling DURDURULDU. Login yapın → polling otomatik resume`);
						this._notifyDiscord(`🔴 Gamesatis oturumu kapanmış — polling durdu. Admin panelden login tetikle: https://cscommends.com/admin`);
						this.stopPolling();
						return;
					}
					this.log.warn(`[gamesatis] ⚠ oturum gerekli (${this._sessionFailCount}/3 — devam)`);
				} else {
					this.log.warn(`[gamesatis] poll hatası: ${msg}`);
				}
			}
		};
		setTimeout(tick, 10000);
		this._pollTimer = setInterval(tick, intervalMs);
		this.emit('statusChanged', this.getStatus());
		return { started: true, intervalSec: this._pollIntervalSec };
	}

	_notifyDiscord(message) {
		try {
			const config = require('../config.json');
			const url = config.webhookUrl;
			if (!url || !url.startsWith('http')) return;
			(global.fetch || require('node-fetch'))(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: message })
			}).catch(() => {});
		} catch {}
	}

	stopPolling() {
		if (!this._pollTimer) return { running: false };
		clearInterval(this._pollTimer);
		this._pollTimer = null;
		this.log.info('[gamesatis] polling durduruldu');
		this.emit('statusChanged', this.getStatus());
		return { stopped: true };
	}

	async shutdown() {
		if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
		if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; }
		if (this._browser) {
			try { await this._browser.close(); } catch {}
			this._browser = null;
		}
	}
}

module.exports = { GamesatisManager };
