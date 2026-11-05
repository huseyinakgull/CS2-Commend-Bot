const https = require('https');
const EventEmitter = require('events');
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const db = require('./database');

const JOIN_CONCURRENCY = 5;
const JOIN_STAGGER_MS = 800;
const JOIN_TIMEOUT_MS = 30 * 1000;
const WEB_SESSION_TIMEOUT_MS = 20 * 1000;
const POST_TIMEOUT_MS = 15 * 1000;

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

class GroupJoinManager extends EventEmitter {
	constructor(botManager, accounts, logger, opts = {}) {
		super();
		this.bm = botManager;
		this.accounts = accounts || [];
		this.log = logger;
		this._running = new Map();
		this._pollTimer = null;
		this._pollInterval = opts.pollInterval || 5000;
		this._sseClients = new Set();
	}

	start() {
		if (this._pollTimer) return;
		this.log.info('[group] Join manager başladı');
		this._pollTimer = setInterval(() => this._tick().catch(err => {
			this.log.error(`[group] tick error: ${err.message}`);
		}), this._pollInterval);
	}

	stop() {
		if (this._pollTimer) clearInterval(this._pollTimer);
		this._pollTimer = null;
	}

	async _tick() {
		if (this._running.size > 0) return;

		const row = db.prepare(`
			SELECT * FROM group_orders
			WHERE status = 'pending'
			ORDER BY id ASC LIMIT 1
		`).get();
		if (!row) return;

		await this._processOrder(row);
	}

	cancelOrder(orderId) {
		const entry = this._running.get(orderId);
		if (entry) entry.cancelled = true;
		db.prepare(`
			UPDATE group_orders
			SET status = 'cancelled', completed_at = datetime('now')
			WHERE id = ? AND status IN ('pending', 'processing')
		`).run(orderId);
		this._broadcast({ type: 'groupStatus', orderId, status: 'cancelled' });
	}

	async _processOrder(order) {
		const ctx = { cancelled: false };
		this._running.set(order.id, ctx);

		try {
			db.prepare('UPDATE group_orders SET status = ?, started_at = datetime(\'now\') WHERE id = ?')
				.run('processing', order.id);
			this._broadcast({ type: 'groupStatus', orderId: order.id, status: 'processing', userId: order.user_id });
			this.log.info(`[group #${order.id}] Start — ${order.requested_count} hedef, groupID ${order.group_id64}`);

			const already = new Set(
				db.prepare('SELECT DISTINCT bot_username FROM group_memberships WHERE group_id64 = ?')
					.all(order.group_id64)
					.map(r => r.bot_username)
			);

			const candidates = this.accounts.filter(a => a && a.username && !already.has(a.username));
			if (candidates.length === 0) {
				this._finishOrder(order.id, 'failed', 'no_bots_available');
				return;
			}

			for (let i = candidates.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[candidates[i], candidates[j]] = [candidates[j], candidates[i]];
			}

			const needed = Math.min(order.requested_count, candidates.length);
			const picked = candidates.slice(0, needed);

			let successCount = 0;
			let attempts = 0;

			const queue = [...picked];
			const workers = [];

			for (let w = 0; w < Math.min(JOIN_CONCURRENCY, queue.length); w++) {
				workers.push((async () => {
					await wait(w * JOIN_STAGGER_MS);
					while (queue.length > 0) {
						if (ctx.cancelled) return;
						const acc = queue.shift();
						if (!acc) return;
						attempts++;

						const result = await this._joinSingle(acc, order.group_id64).catch(err => ({ success: false, error: err.message }));

						try {
							db.prepare(`
								INSERT INTO group_memberships (order_id, bot_username, bot_steam_id, group_id64, result, error)
								VALUES (?, ?, ?, ?, ?, ?)
							`).run(order.id, acc.username, result.steamId || null, order.group_id64,
							       result.success ? 'success' : 'fail', result.error || null);
						} catch {}

						if (result.success) {
							successCount++;
							db.prepare('UPDATE group_orders SET joined_count = ? WHERE id = ?').run(successCount, order.id);
							this._broadcast({
								type: 'groupProgress',
								orderId: order.id,
								joined: successCount,
								total: order.requested_count,
								userId: order.user_id
							});
						}

						if (successCount >= order.requested_count) return;
					}
				})());
			}

			await Promise.all(workers);

			if (ctx.cancelled) {
				this._finishOrder(order.id, 'cancelled');
			} else if (successCount >= order.requested_count) {
				this._finishOrder(order.id, 'completed');
			} else {
				this._finishOrder(order.id, 'failed',
					`only_${successCount}_of_${order.requested_count}_joined_after_${attempts}_attempts`);
			}

		} catch (err) {
			this.log.error(`[group #${order.id}] fatal: ${err.message}`);
			this._finishOrder(order.id, 'failed', err.message);
		} finally {
			this._running.delete(order.id);
		}
	}

	_finishOrder(orderId, status, errorMsg) {
		try {
			db.prepare(`
				UPDATE group_orders
				SET status = ?, last_error = ?, completed_at = datetime('now')
				WHERE id = ?
			`).run(status, errorMsg || null, orderId);
		} catch {}
		const row = db.prepare('SELECT user_id, joined_count, requested_count FROM group_orders WHERE id = ?').get(orderId);
		this._broadcast({
			type: 'groupStatus',
			orderId, status,
			joined: row ? row.joined_count : 0,
			total: row ? row.requested_count : 0,
			userId: row ? row.user_id : null,
			error: errorMsg || null
		});
		this.log.info(`[group #${orderId}] finished: ${status}` + (errorMsg ? ` (${errorMsg})` : ''));
	}

	_joinSingle(account, groupId64) {
		return new Promise((resolve) => {
			let settled = false;
			const finish = (result) => {
				if (settled) return;
				settled = true;
				try { steam.logOff(); } catch {}
				try { steam.removeAllListeners(); } catch {}
				resolve(result);
			};

			const steam = new SteamUser({ autoRelogin: false });

			const guard = setTimeout(() => finish({ success: false, error: 'overall_timeout' }), JOIN_TIMEOUT_MS);

			steam.on('error', (err) => {
				clearTimeout(guard);
				finish({ success: false, error: `steam_error:${err.message}` });
			});

			steam.on('loggedOn', () => {
				try {
					const sid = steam.steamID.getSteamID64();
					const webTimeout = setTimeout(() => {
						clearTimeout(guard);
						finish({ success: false, error: 'webSession_timeout', steamId: sid });
					}, WEB_SESSION_TIMEOUT_MS);

					steam.once('webSession', (sessionID, cookies) => {
						clearTimeout(webTimeout);
						this._postJoinRequest(groupId64, sessionID, cookies)
							.then(ok => {
								clearTimeout(guard);
								finish({ success: ok.success, error: ok.error || null, steamId: sid });
							})
							.catch(err => {
								clearTimeout(guard);
								finish({ success: false, error: `post_failed:${err.message}`, steamId: sid });
							});
					});

					try { steam.webLogOn(); } catch (err) {
						clearTimeout(webTimeout);
						clearTimeout(guard);
						finish({ success: false, error: `webLogOn_error:${err.message}`, steamId: sid });
					}
				} catch (err) {
					clearTimeout(guard);
					finish({ success: false, error: `steamId_error:${err.message}` });
				}
			});

			try {
				steam.logOn({
					accountName: account.username,
					password: account.password,
					twoFactorCode: (account.sharedSecret && account.sharedSecret.length > 5)
						? SteamTotp.getAuthCode(account.sharedSecret) : undefined
				});
			} catch (err) {
				clearTimeout(guard);
				finish({ success: false, error: `login_error:${err.message}` });
			}
		});
	}

	_postJoinRequest(groupId64, sessionID, cookies) {
		return new Promise((resolve) => {
			const body = `sessionID=${encodeURIComponent(sessionID)}&action=join`;
			const cookieHeader = cookies.join('; ');
			const req = https.request({
				hostname: 'steamcommunity.com',
				path: `/gid/${encodeURIComponent(groupId64)}`,
				method: 'POST',
				timeout: POST_TIMEOUT_MS,
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'Content-Length': Buffer.byteLength(body),
					'Cookie': cookieHeader,
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) cs-commends/1.0',
					'Referer': `https://steamcommunity.com/gid/${groupId64}`
				}
			}, (res) => {
				let chunks = '';
				res.on('data', (c) => { chunks += c; });
				res.on('end', () => {
					if (res.statusCode === 302 || res.statusCode === 200) {
						const txt = chunks.toLowerCase();
						if (txt.includes('please enable javascript')) {
							return resolve({ success: false, error: 'session_rejected' });
						}
						if (txt.includes('this group is restricted') ||
						    txt.includes('invite-only') ||
						    txt.includes('does not exist')) {
							return resolve({ success: false, error: 'group_restricted_or_missing' });
						}
						return resolve({ success: true });
					}
					resolve({ success: false, error: `http_${res.statusCode}` });
				});
			});
			req.on('error', (err) => resolve({ success: false, error: `req_err:${err.message}` }));
			req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'post_timeout' }); });
			req.write(body);
			req.end();
		});
	}

	listUserOrders(userId) {
		return db.prepare(`
			SELECT id, group_id64, group_vanity, group_name, group_avatar,
			       requested_count, joined_count, status, last_error,
			       started_at, completed_at, created_at
			FROM group_orders
			WHERE user_id = ?
			ORDER BY id DESC
		`).all(userId);
	}

	getOrder(orderId) {
		return db.prepare('SELECT * FROM group_orders WHERE id = ?').get(orderId);
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
}

module.exports = GroupJoinManager;
