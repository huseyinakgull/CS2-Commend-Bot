const https = require('https');
const http = require('http');
const EventEmitter = require('events');
const db = require('./database');
const { transitionTransactionStatus } = require('./database');
const HudNotify = require('../helpers/HudNotify');
let _botConfig = null;
function _getServerCfg() {
	if (!_botConfig) { try { _botConfig = require('../config.json'); } catch { _botConfig = { server: null }; } }
	return _botConfig.server;
}

function failWithRefund(tx, errorType, errorMessage, processingTime, log) {
	let liveProgress = tx.progress || 0;
	try {
		const fresh = db.prepare('SELECT progress FROM transactions WHERE id = ?').get(tx.id);
		if (fresh && typeof fresh.progress === 'number') liveProgress = fresh.progress;
	} catch {}
	const targetStatus = (liveProgress > 0) ? 'partial' : 'failed';

	const result = transitionTransactionStatus(
		tx.id,
		['pending', 'processing', 'resuming'],
		targetStatus,
		{ refund: true }
	);

	if (!result.changed) {
		log && log.warn(`Transaction #${tx.id}: already finalized (status=${result.previousStatus}) — refund/fail skipped`);
		return 0;
	}

	const enrichedMessage = (result.refunded > 0 && errorMessage)
		? `${errorMessage} — ${result.refunded} övgü bakiyenize iade edildi`
		: errorMessage;

	db.prepare(
		`UPDATE transactions SET error_type = ?, error_message = ?, processing_time_ms = ? WHERE id = ?`
	).run(errorType, enrichedMessage, processingTime, tx.id);

	if (result.refunded > 0 && log) {
		log.info(`Transaction #${tx.id}: ${result.refunded} övgü bakiyeye iade edildi (atomic, status=${targetStatus})`);
	}
	return result.refunded;
}

const PRIORITY = { normal: 0, high: 1, urgent: 2 };
const PRIORITY_NAMES = { 0: 'normal', 1: 'high', 2: 'urgent' };

const ERROR_TYPES = {
	BOT_ERROR: 'bot_error',
	NETWORK_ERROR: 'network_error',
	TARGET_ERROR: 'target_error',
	RATE_LIMIT: 'rate_limit',
	UNKNOWN: 'unknown'
};

const RETRY_STRATEGIES = {
	[ERROR_TYPES.BOT_ERROR]:     { maxRetries: 2, baseDelay: 5000,  backoffMultiplier: 2 },
	[ERROR_TYPES.NETWORK_ERROR]: { maxRetries: 3, baseDelay: 10000, backoffMultiplier: 2 },
	[ERROR_TYPES.TARGET_ERROR]:  { maxRetries: 0, baseDelay: 0,     backoffMultiplier: 1 },
	[ERROR_TYPES.RATE_LIMIT]:    { maxRetries: 3, baseDelay: 30000, backoffMultiplier: 3 },
	[ERROR_TYPES.UNKNOWN]:       { maxRetries: 2, baseDelay: 5000,  backoffMultiplier: 2 }
};

try {
	db.exec(`ALTER TABLE transactions ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`);
} catch {}
try {
	db.exec(`ALTER TABLE transactions ADD COLUMN error_type TEXT`);
} catch {}
try {
	db.exec(`ALTER TABLE transactions ADD COLUMN error_message TEXT`);
} catch {}
try {
	db.exec(`ALTER TABLE transactions ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`);
} catch {}
try {
	db.exec(`ALTER TABLE transactions ADD COLUMN started_at TEXT`);
} catch {}
try {
	db.exec(`ALTER TABLE transactions ADD COLUMN processing_time_ms INTEGER`);
} catch {}
try {
	db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_priority ON transactions(priority)`);
} catch {}
try {
	db.exec(`ALTER TABLE transactions ADD COLUMN commends_before INTEGER`);
} catch {}
try {
	db.exec(`ALTER TABLE transactions ADD COLUMN commends_after INTEGER`);
} catch {}
try {
	db.exec(`ALTER TABLE transactions ADD COLUMN verified_delivered INTEGER`);
} catch {}

const stmts = {
	fetchPending: db.prepare(
		`SELECT * FROM transactions WHERE status IN ('pending','resuming')
		 ORDER BY priority DESC, created_at ASC LIMIT ?`
	),
	markProcessing: db.prepare(
		`UPDATE transactions SET status = 'processing', started_at = datetime('now')
		 WHERE id = ? AND status IN ('pending','resuming')`
	),
	updateProgress: db.prepare(
		`UPDATE transactions SET progress = ? WHERE id = ?`
	),
	markCompleted: db.prepare(
		`UPDATE transactions SET status = ?, progress = ?, completed_at = datetime('now'),
		 processing_time_ms = ? WHERE id = ?`
	),
	saveCommendsBefore: db.prepare(
		`UPDATE transactions SET commends_before = ? WHERE id = ?`
	),
	saveCommendsAfter: db.prepare(
		`UPDATE transactions SET commends_after = ?, verified_delivered = ? WHERE id = ?`
	),
	markFailed: db.prepare(
		`UPDATE transactions SET status = 'failed', completed_at = datetime('now'),
		 error_type = ?, error_message = ?, processing_time_ms = ? WHERE id = ?`
	),
	markPending: db.prepare(
		`UPDATE transactions SET status = 'pending', retry_count = ?
		 WHERE id = ? AND status IN ('processing','resuming','pending')`
	),
	getStatus: db.prepare(
		`SELECT status FROM transactions WHERE id = ?`
	),
	setPriority: db.prepare(
		`UPDATE transactions SET priority = ? WHERE id = ? AND status IN ('pending','resuming')`
	),
	refundUser: db.prepare(
		`UPDATE users SET balance = balance + ? WHERE id = ?`
	),
	pendingCount: db.prepare(
		`SELECT COUNT(*) as count FROM transactions WHERE status = 'pending'`
	),
	processingCount: db.prepare(
		`SELECT COUNT(*) as count FROM transactions WHERE status = 'processing'`
	),
	recoverProcessing: db.prepare(
		`UPDATE transactions SET status = 'resuming' WHERE status = 'processing'`
	),
	allPendingForQueue: db.prepare(
		`SELECT id, priority, created_at FROM transactions WHERE status IN ('pending','resuming')
		 ORDER BY priority DESC, created_at ASC`
	)
};

class TransactionProcessor extends EventEmitter {
	constructor(botManager, logger, options = {}) {
		super();

		this.manager = botManager;
		this.log = logger;
		this.pollInterval = options.pollInterval || 5000;
		this.delayBetweenCommends = options.delayBetweenCommends || 250;
		this.verifyCommends = options.verifyCommends || false;
		this.maxRetries = options.maxRetries || 2;

		this._webhookUrls = [];
		if (options.webhookUrl) {
			this._webhookUrls = Array.isArray(options.webhookUrl) ? options.webhookUrl : [options.webhookUrl];
		}
		if (options.webhookUrls) {
			this._webhookUrls = this._webhookUrls.concat(
				Array.isArray(options.webhookUrls) ? options.webhookUrls : [options.webhookUrls]
			);
		}
		this.webhookRetries = options.webhookRetries || 3;
		this.discordWebhookFormat = options.discordWebhookFormat || false;

		this.concurrency = Math.max(1, options.concurrency || 3);
		this._activeTransactions = new Map();
		this._processing = false;

		this._timer = null;
		this._heartbeatTimer = null;

		this._sseClients = new Set();

		this._retryCount = new Map();

		this._errorCounts = { bot_error: 0, network_error: 0, target_error: 0, rate_limit: 0, unknown: 0 };
		this._recentErrors = [];

		this._rateLimitedBotCount = 0;
		this._adaptiveDelay = this.delayBetweenCommends;
		this._successWindow = [];
		this._failWindow = [];

		this._hooks = {
			onTransactionStart: [],
			onTransactionProgress: [],
			onTransactionComplete: [],
			onTransactionFail: []
		};

		this._stats = {
			startTime: Date.now(),
			totalProcessed: 0,
			totalSuccess: 0,
			totalFailed: 0,
			totalUserError: 0,
			totalCommends: 0,
			totalCommendSuccess: 0,
			totalCommendFail: 0,
			processingTimes: [],
			commendsPerMinuteWindow: []
		};

		this._commendLog = [];

		this._recoverOnStartup();
	}

	_recoverOnStartup() {
		const recovered = stmts.recoverProcessing.run();
		if (recovered.changes > 0) {
			this.log.info(`Recovered ${recovered.changes} transaction(s) from previous crash → will resume`);
		}
	}

	async _resolveStuck(txId, errorType = 'pipeline_jam', message = 'Otomatik kurtarma — işlem çok uzun süre takılı kaldı') {
		try {
			const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
			if (!tx) return { resolved: false, refunded: 0, status: 'not_found' };

			if (!['pending', 'processing', 'resuming'].includes(tx.status)) {
				return { resolved: false, refunded: 0, status: tx.status };
			}

			const processingTime = tx.started_at
				? Date.now() - new Date(tx.started_at).getTime()
				: 0;

			this.log.warn(`Transaction #${txId}: SELF-HEAL kurtarma — ${message}`);
			const refund = failWithRefund(tx, errorType, message, processingTime, this.log);

			if (this._activeTransactions.has(txId)) {
				this._activeTransactions.delete(txId);
			}
			this._retryCount.delete(txId);

			const updated = db.prepare('SELECT status FROM transactions WHERE id = ?').get(txId);
			this._broadcast('transactionUpdate', {
				id: txId,
				status: updated?.status || 'failed',
				error: message,
				errorType,
				processingTimeMs: processingTime,
				refunded: refund,
				selfHealed: true
			});

			return { resolved: true, refunded: refund, status: updated?.status || 'failed' };
		} catch (err) {
			this.log.error(`_resolveStuck error for #${txId}: ${err.message}`);
			return { resolved: false, refunded: 0, status: 'error', error: err.message };
		}
	}

	setPriority(txId, priority) {
		const level = typeof priority === 'string' ? PRIORITY[priority] : priority;
		if (level === undefined || level < 0 || level > 2) {
			throw new Error(`Invalid priority: ${priority}. Use: normal, high, urgent`);
		}
		const result = stmts.setPriority.run(level, txId);
		if (result.changes > 0) {
			this.log.info(`Transaction #${txId} priority set to ${PRIORITY_NAMES[level]}`);
			this._broadcast('priorityUpdate', { id: txId, priority: PRIORITY_NAMES[level] });
		}
		return result.changes > 0;
	}

	onTransactionStart(fn)    { this._hooks.onTransactionStart.push(fn); }
	onTransactionProgress(fn) { this._hooks.onTransactionProgress.push(fn); }
	onTransactionComplete(fn) { this._hooks.onTransactionComplete.push(fn); }
	onTransactionFail(fn)     { this._hooks.onTransactionFail.push(fn); }

	_fireHook(name, ...args) {
		for (const fn of this._hooks[name]) {
			try { fn(...args); } catch (err) {
				this.log.warn(`Hook ${name} error: ${err.message}`);
			}
		}
		this.emit(name, ...args);
	}

	addSSEClient(res) {
		this._sseClients.add(res);
		res.on('close', () => this._sseClients.delete(res));

		this._sendSSE(res, 'connected', {
			serverTime: new Date().toISOString(),
			activeTransactions: this._activeTransactions.size,
			concurrency: this.concurrency
		});
	}

	_broadcast(event, data) {
		const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const client of this._sseClients) {
			try { client.write(msg); } catch {}
		}
	}

	_sendSSE(client, event, data) {
		try {
			client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		} catch {}
	}

	_broadcastBotStatus() {
		if (this._sseClients.size === 0) return;
		const bots = this.manager.bots.map(b => ({
			username: b.username,
			state: b.state,
			isReady: b.isReady,
			isOnServer: b.isOnServer,
			isOnCooldown: b.isOnCooldown || false
		}));
		this._broadcast('botStatus', { bots });
	}

	_broadcastQueuePositions() {
		if (this._sseClients.size === 0) return;
		const queue = stmts.allPendingForQueue.all();
		const positions = queue.map((row, idx) => ({
			id: row.id,
			position: idx + 1,
			priority: PRIORITY_NAMES[row.priority] || 'normal'
		}));
		this._broadcast('queuePositions', { queue: positions, total: positions.length });
	}

	start() {
		if (this._timer) return;
		this.log.info(`Transaction processor started (poll: ${this.pollInterval}ms, concurrency: ${this.concurrency})`);

		this._timer = setInterval(() => this._poll(), this.pollInterval);
		this._timer.unref();

		this._heartbeatTimer = setInterval(() => {
			this._broadcast('heartbeat', {
				serverTime: new Date().toISOString(),
				activeTransactions: this._activeTransactions.size,
				adaptiveDelay: this._adaptiveDelay
			});
			this._broadcastBotStatus();
			this._broadcastQueuePositions();
		}, 15000);
		this._heartbeatTimer.unref();

		this._poll();
	}

	stop() {
		if (this._timer) {
			clearInterval(this._timer);
			this._timer = null;
		}
		if (this._heartbeatTimer) {
			clearInterval(this._heartbeatTimer);
			this._heartbeatTimer = null;
		}
		this.log.info('Transaction processor stopped');
	}

	isRunning() {
		return !!this._timer;
	}

	// Picks up pending transactions from SQLite, up to the concurrency limit.
	async _poll() {
		try {
			const maintenance = require('./database').getSetting('maintenance_mode', '0');
			if (maintenance === '1') {
				return;
			}
		} catch {}

		const freeSlots = this.concurrency - this._activeTransactions.size;
		if (freeSlots <= 0) return;

		const pending = stmts.fetchPending.all(freeSlots);
		if (pending.length === 0) return;

		for (const tx of pending) {
			if (this._activeTransactions.has(tx.id)) continue;

			const startTime = Date.now();
			const promise = this._processWithRetry(tx, startTime);
			this._activeTransactions.set(tx.id, { promise, tx, startTime });

			promise.finally(() => {
				this._activeTransactions.delete(tx.id);
			});
		}
	}

	// Failures are classified and retried with per-type exponential backoff.
	// When retries run out the transaction is marked failed (or partial) and the
	// undelivered commends are refunded to the user's balance.
	async _processWithRetry(tx, startTime) {
		try {
			await this._processTransaction(tx, startTime);
			this._retryCount.delete(tx.id);
		} catch (err) {
			const errorType = this._classifyError(err);
			this._trackError(errorType, err, tx.id);

			const strategy = RETRY_STRATEGIES[errorType];
			const retryInfo = this._retryCount.get(tx.id) || { count: 0, errorType };
			retryInfo.count++;
			retryInfo.errorType = errorType;
			this._retryCount.set(tx.id, retryInfo);

			const maxRetries = Math.min(strategy.maxRetries, this.maxRetries);

			if (retryInfo.count <= maxRetries) {
				const delay = strategy.baseDelay * Math.pow(strategy.backoffMultiplier, retryInfo.count - 1);
				this.log.warn(
					`Transaction #${tx.id} ${errorType} (retry ${retryInfo.count}/${maxRetries}, ` +
					`next in ${Math.round(delay / 1000)}s): ${err.message}`
				);
				const r = stmts.markPending.run(retryInfo.count, tx.id);
				if (r.changes === 0) {
					const cur = stmts.getStatus.get(tx.id);
					this.log.warn(`Transaction #${tx.id}: zaten finalize edilmiş (status=${cur?.status}), retry iptal — exception finalize sonrası geldi`);
					this._retryCount.delete(tx.id);
					return;
				}

				await new Promise(r => setTimeout(r, delay));
			} else {
				const processingTime = Date.now() - startTime;
				this.log.error(`Transaction #${tx.id} failed permanently (${errorType}): ${err.message}`);

				const refund = failWithRefund(tx, errorType, err.message, processingTime, this.log);
				try { require('./lib/metrics').recordTransaction('failed', { refunded: refund, reason: errorType }); } catch {}

				this._broadcast('transactionUpdate', {
					id: tx.id,
					status: 'failed',
					error: err.message,
					errorType,
					processingTimeMs: processingTime,
					refunded: refund
				});

				if (errorType === ERROR_TYPES.TARGET_ERROR) {
					this._stats.totalUserError++;
				} else {
					this._stats.totalFailed++;
				}
				this._stats.totalProcessed++;
				this._recordProcessingTime(processingTime);

				this._fireHook('onTransactionFail', tx, {
					error: err.message,
					errorType,
					retries: retryInfo.count,
					processingTimeMs: processingTime,
					refunded: refund
				});

				this._retryCount.delete(tx.id);
				this._sendAllWebhooks('transaction_failed', {
					id: tx.id,
					error: err.message,
					errorType,
					refunded: refund
				});
			}
		}
	}

	async _processTransaction(tx, startTime) {
		const preCheck = stmts.getStatus.get(tx.id);
		if (preCheck && (preCheck.status === 'cancelled' || preCheck.status === 'failed')) {
			this.log.info(`Transaction #${tx.id}: Zaten ${preCheck.status} durumunda, atlanıyor`);
			return;
		}

		const isResume = tx.status === 'resuming';
		let currentProgress = tx.progress || 0;

		if (currentProgress >= tx.total) {
			stmts.markCompleted.run('completed', tx.total, Date.now() - startTime, tx.id);
			return;
		}

		this.log.info(
			`${isResume ? 'Resuming' : 'Processing'} transaction #${tx.id} → ${tx.steam_id} ` +
			`(${tx.total - currentProgress} remaining of ${tx.total} commends) [priority: ${PRIORITY_NAMES[tx.priority] || 'normal'}]`
		);

		stmts.markProcessing.run(tx.id);

		this._broadcast('transactionUpdate', {
			id: tx.id,
			status: 'processing',
			progress: currentProgress,
			total: tx.total,
			priority: PRIORITY_NAMES[tx.priority] || 'normal'
		});

		this._fireHook('onTransactionStart', tx);

		HudNotify.notifyStarted(_getServerCfg(), tx.steam_id, tx.total, tx.id).catch(() => {});
		let _lastHudProgress = currentProgress;

		let targetAccountId;
		try {
			targetAccountId = this._parseAccountId(tx.steam_id);
		} catch {
			throw new Error('Invalid Steam ID: ' + tx.steam_id);
		}

		this._updateAdaptiveDelay();

		if (this.manager.checkPlayerOnServer) {
			const RETRY_SCHEDULE = [15, 15, 15, 15, 30, 30, 30, 30];
			const TOTAL_WAIT_SEC = RETRY_SCHEDULE.reduce((a, b) => a + b, 0);
			let presenceConfirmed = false;
			let presenceLastResult = null;
			let waitedSoFar = 0;

			for (let attempt = 0; attempt <= RETRY_SCHEDULE.length; attempt++) {
				try {
					presenceLastResult = await this.manager.checkPlayerOnServer(targetAccountId);
				} catch (err) {
					this.log.warn(`Sunucu kontrol hatası (deneme ${attempt + 1}): ${err.message}`);
					presenceLastResult = null;
				}

				if (presenceLastResult !== false) {
					presenceConfirmed = true;
					if (attempt > 0) {
						this.log.info(`Transaction #${tx.id}: Hedef ${waitedSoFar}s sonra sunucuya bağlandı — işlem başlatılıyor`);
					}
					break;
				}

				if (attempt < RETRY_SCHEDULE.length) {
					const delay = RETRY_SCHEDULE[attempt];
					const remaining = TOTAL_WAIT_SEC - waitedSoFar;
					this.log.info(`Transaction #${tx.id}: Hedef şu an sunucuda değil — ${delay}s sonra tekrar denenecek (${attempt + 1}/${RETRY_SCHEDULE.length}, ${remaining}s kaldı)`);
					this._broadcast('transactionUpdate', {
						id: tx.id, status: 'pending', progress: currentProgress, total: tx.total,
						message: `Hedef sunucuya bağlanması bekleniyor — ${remaining} saniye kaldı (CS2 yükleme süresi normaldir)`
					});
					await new Promise(r => setTimeout(r, delay * 1000));
					waitedSoFar += delay;
				}
			}

			if (!presenceConfirmed) {
				this.log.error(`Transaction #${tx.id}: Hedef ${TOTAL_WAIT_SEC}s boyunca sunucuya bağlanmadı — iptal ediliyor`);
				failWithRefund(tx, 'target_error', `Hedef oyuncu sunucuya bağlanmadı (${TOTAL_WAIT_SEC}s/${Math.round(TOTAL_WAIT_SEC/60)}dk bekledik) — bakiye iade edildi`, Date.now() - startTime, this.log);
				this._broadcast('transactionUpdate', {
					id: tx.id, status: 'failed', progress: currentProgress, total: tx.total,
					message: `Hedef ${Math.round(TOTAL_WAIT_SEC/60)} dakika boyunca sunucuya bağlanmadı. Bakiye iade edildi. CS2'yi açıp aktif maça gir, sonra tekrar dene.`
				});
				this._stats.totalProcessed++;
				this._stats.totalUserError++;
				return;
			}
		}

		let commendsBefore = null;
		try {
			const profileBefore = await this.manager.getPlayerCommendCount(targetAccountId);
			if (profileBefore) {
				commendsBefore = profileBefore.friendly + profileBefore.teaching + profileBefore.leader;
				stmts.saveCommendsBefore.run(commendsBefore, tx.id);
				this.log.info(`İşlem #${tx.id} öncesi övgü sayısı: ${commendsBefore} (F:${profileBefore.friendly} T:${profileBefore.teaching} L:${profileBefore.leader})`);
			}
		} catch (err) {
			this.log.warn(`İşlem #${tx.id} övgü sayısı sorgulanamadı: ${err.message}`);
		}

		const MAX_ROUNDS = 5;
		let round = 0;
		let totalSuccess = 0;
		let totalFail = 0;

		let playerLeft = false;
		let consecutiveOff = 0;
		const OFF_THRESHOLD = 3;
		const presenceWatcher = setInterval(async () => {
			if (playerLeft) return;
			try {
				const still = await this.manager.checkPlayerOnServer(targetAccountId);
				if (still === false) {
					consecutiveOff++;
					if (consecutiveOff < OFF_THRESHOLD) {
						this.log.warn(`Transaction #${tx.id}: Hedef OFF görüldü (${consecutiveOff}/${OFF_THRESHOLD}) — teyit bekleniyor`);
						return;
					}
					playerLeft = true;
					this.log.error(`Transaction #${tx.id}: Hedef sunucudan ayrıldı — işlem durduruluyor`);
					this.manager.cancelCommendPlayer && this.manager.cancelCommendPlayer(targetAccountId);
				} else {
					consecutiveOff = 0;
				}
			} catch {}
		}, 45000);
		presenceWatcher.unref && presenceWatcher.unref();

		while (currentProgress < tx.total && round < MAX_ROUNDS) {
			round++;
			const remaining = tx.total - currentProgress;

			const currentStatus = stmts.getStatus.get(tx.id);
			if (currentStatus && currentStatus.status === 'cancelled') {
				this.log.info(`Transaction #${tx.id} iptal edildi`);
				break;
			}

			const availableAccounts = this.manager.getAvailableBotsForTarget(targetAccountId);
			if (availableAccounts.length === 0) {
				this.log.warn(`Transaction #${tx.id}: Havuzda bu hedefe uygun hesap kalmadı`);
				this._broadcast('transactionUpdate', {
					id: tx.id,
					status: 'waiting_bots',
					progress: currentProgress,
					total: tx.total,
					message: 'Havuzda uygun hesap kalmadı — yöneticiyle iletişime geçin'
				});
				throw new Error('No eligible accounts remaining for this target');
			}

			const botsToUse = Math.min(availableAccounts.length, remaining);
			this.log.info(`Transaction #${tx.id} round ${round}: ${botsToUse} hesap ile ${remaining} övgü gönderilecek`);

			let lastProgressSave = Date.now();

			const result = await this.manager.commendPlayer(targetAccountId, {
				count: botsToUse,
				friendly: tx.friendly > 0,
				teaching: tx.teaching > 0,
				leader: tx.leader > 0,
				delayMs: this._adaptiveDelay,
				isCancelled: () => {
					if (playerLeft) return true;
					try {
						const s = stmts.getStatus.get(tx.id);
						return s && (s.status === 'cancelled' || s.status === 'failed');
					} catch { return false; }
				},
				onProgress: (progress) => {
					const absoluteProgress = currentProgress + progress.success;
					const now = Date.now();

					if (now - lastProgressSave >= 2000) {
						stmts.updateProgress.run(absoluteProgress, tx.id);
						lastProgressSave = now;
					}

					this._logCommendAttempt(tx.id, progress);
					this._stats.totalCommends++;
					this._stats.commendsPerMinuteWindow.push(now);

					this._broadcast('transactionUpdate', {
						id: tx.id,
						status: 'processing',
						progress: absoluteProgress,
						total: tx.total,
						fail: totalFail + progress.fail,
						successRate: (currentProgress + progress.success) > 0
							? (((currentProgress + progress.success) / tx.total) * 100).toFixed(1)
							: '0.0'
					});

					if (Math.floor(absoluteProgress / 10) > Math.floor(_lastHudProgress / 10)) {
						_lastHudProgress = absoluteProgress;
						HudNotify.notifyProgress(_getServerCfg(), tx.steam_id, absoluteProgress, tx.total).catch(() => {});
					}

					if (progress.success > this._successWindow.length) {
						this._successWindow.push(now);
					}
					if (progress.fail > this._failWindow.length) {
						this._failWindow.push(now);
					}
				}
			});

			totalSuccess += result.success;
			totalFail += result.fail;
			currentProgress += result.success;

			stmts.updateProgress.run(currentProgress, tx.id);

			this.log.info(`Transaction #${tx.id} round ${round} sonuç: +${result.success} başarılı, +${result.fail} başarısız → ${currentProgress}/${tx.total}`);

			if (result.cancelled || playerLeft) {
				this.log.warn(`Transaction #${tx.id}: İşlem iptal edildi${playerLeft ? ' (hedef sunucudan ayrıldı)' : ''}, döngü durduruluyor`);
				break;
			}

			if (result.rateLimited) {
				this.log.error(`Transaction #${tx.id}: GC rate limit — sunucu SteamID değişemiyor, işlem durduruluyor`);
				this.log.error(`ÇÖZÜM: Sunucuyu GSLT'siz yeniden başlatın veya farklı sunucu kullanın`);
				break;
			}

			const statusCheck = stmts.getStatus.get(tx.id);
			if (statusCheck && (statusCheck.status === 'cancelled' || statusCheck.status === 'failed')) {
				this.log.warn(`Transaction #${tx.id}: DB'de ${statusCheck.status} olarak işaretlenmiş, durduruluyor`);
				break;
			}

			if (result.success === 0 && result.fail > 0) {
				if (round < MAX_ROUNDS) {
					this.log.warn(`Transaction #${tx.id}: Bu roundda 0 başarı — GC rate-limit bekleniyor (90s)...`);
					this._broadcast('transactionUpdate', {
						id: tx.id,
						status: 'processing',
						progress: currentProgress,
						total: tx.total,
						message: 'Steam rate-limit bekleniyor, kısa süre sonra devam edecek...'
					});
					await new Promise(r => setTimeout(r, 90000));
					continue;
				}
				this.log.warn(`Transaction #${tx.id}: Son roundda da 0 başarı — döngü durduruluyor`);
				break;
			}

			if (currentProgress < tx.total && round < MAX_ROUNDS) {
				this.log.info(`Transaction #${tx.id}: Round arası bekleme (15s)`);
				await new Promise(r => setTimeout(r, 15000));
			}
		}

		clearInterval(presenceWatcher);

		if (playerLeft) {
			const refund = failWithRefund(tx, 'target_error', 'Hedef sunucudan ayrıldı', Date.now() - startTime, this.log);
			try { require('./lib/metrics').recordTransaction('failed', { refunded: refund, reason: 'target_left_server' }); } catch {}
			this._broadcast('transactionUpdate', {
				id: tx.id, status: 'failed', progress: currentProgress, total: tx.total,
				message: 'Hedef sunucudan ayrıldı — işlem durduruldu',
				refunded: refund
			});
			this._stats.totalProcessed++;
			this._stats.totalUserError++;
			this._fireHook('onTransactionFail', tx, {
				error: 'Hedef sunucudan ayrıldı',
				errorType: ERROR_TYPES.TARGET_ERROR,
				processingTimeMs: Date.now() - startTime,
				refunded: refund
			});
			return;
		}

		let commendsAfter = null;
		let verifiedDelivered = null;
		try {
			await new Promise(r => setTimeout(r, 5000));
			const profileAfter = await this.manager.getPlayerCommendCount(targetAccountId);
			if (profileAfter) {
				commendsAfter = profileAfter.friendly + profileAfter.teaching + profileAfter.leader;
				this.log.info(`İşlem #${tx.id} sonrası övgü sayısı: ${commendsAfter} (F:${profileAfter.friendly} T:${profileAfter.teaching} L:${profileAfter.leader})`);

				if (commendsBefore !== null) {
					verifiedDelivered = commendsAfter - commendsBefore;
					const expected = currentProgress;
					stmts.saveCommendsAfter.run(commendsAfter, verifiedDelivered, tx.id);

					if (verifiedDelivered >= expected) {
						this.log.success(`DOĞRULAMA BAŞARILI: ${verifiedDelivered} övgü teslim edildi (beklenen: ${expected})`);
					} else if (verifiedDelivered > 0) {
						this.log.warn(`DOĞRULAMA: ${verifiedDelivered}/${expected} övgü gerçekten ulaştı — ${expected - verifiedDelivered} övgü eksik`);
						const missingCount = expected - verifiedDelivered;
						this.log.info(`Eksik ${missingCount} övgü için ek gönderim başlatılıyor...`);
						try {
							const extraResult = await this.manager.commendPlayer(targetAccountId, {
								count: missingCount,
								friendly: tx.friendly > 0,
								teaching: tx.teaching > 0,
								leader: tx.leader > 0
							});
							if (extraResult.success > 0) {
								totalSuccess += extraResult.success;
								currentProgress += extraResult.success;
								this.log.success(`Ek gönderim: +${extraResult.success} başarılı`);

								await new Promise(r => setTimeout(r, 5000));
								const profileFinal = await this.manager.getPlayerCommendCount(targetAccountId);
								if (profileFinal) {
									const finalCount = profileFinal.friendly + profileFinal.teaching + profileFinal.leader;
									verifiedDelivered = finalCount - commendsBefore;
									stmts.saveCommendsAfter.run(finalCount, verifiedDelivered, tx.id);
									this.log.info(`Final doğrulama: ${verifiedDelivered} övgü teslim edildi`);
								}
							}
						} catch (extraErr) {
							this.log.warn(`Ek gönderim başarısız: ${extraErr.message}`);
						}
					} else {
						this.log.error(`DOĞRULAMA BAŞARISIZ: 0 övgü ulaştı! GC tüm commend'leri görmezden gelmiş`);
					}
				}
			}
		} catch (verifyErr) {
			this.log.warn(`İşlem sonrası doğrulama başarısız: ${verifyErr.message}`);
		}

		const finalProgress = currentProgress;
		const processingTime = Date.now() - startTime;

		const finalStatusCheck = stmts.getStatus.get(tx.id);
		const wasCancelled = finalStatusCheck && finalStatusCheck.status === 'cancelled';

		if (wasCancelled) {
			this.log.info(`Transaction #${tx.id}: İptal edildi, ${finalProgress}/${tx.total} tamamlanmış`);
			this._broadcast('transactionUpdate', {
				id: tx.id, status: 'cancelled', progress: finalProgress, total: tx.total
			});
			this._stats.totalProcessed++;
			this._stats.totalFailed++;
			return;
		}

		const finalStatus = finalProgress >= tx.total ? 'completed' : (finalProgress > 0 ? 'partial' : 'failed');

		if (finalStatus !== 'failed' || finalProgress > 0) {
			HudNotify.notifyDone(_getServerCfg(), tx.steam_id, finalProgress, tx.total).catch(() => {});
		}

		if (finalStatus === 'partial') {
			const cacheSize = this.manager._commendCache.has(targetAccountId)
				? this.manager._commendCache.get(targetAccountId).size : 0;
			const unusedAccounts = this.manager._accounts.length - cacheSize;

			if (unusedAccounts > 10) {
				db.prepare("UPDATE transactions SET status = 'pending' WHERE id = ?").run(tx.id);
				this.log.info(`Transaction #${tx.id}: ${finalProgress}/${tx.total} — ${unusedAccounts} hesap kaldı, devam edecek`);
				this._broadcast('transactionUpdate', {
					id: tx.id, status: 'pending', progress: finalProgress, total: tx.total,
					message: `${unusedAccounts} hesap kaldı`
				});
				return;
			} else {
				this.log.warn(`Transaction #${tx.id}: ${finalProgress}/${tx.total} — hesap havuzu tükendi, işlem tamamlanıyor`);
			}
		}

		{
			const isFailedZero = finalStatus === 'failed' && finalProgress === 0;
			const errorType = isFailedZero ? 'bot_error' : null;
			const errorMessage = isFailedZero
				? `Tüm denemeler başarısız oldu (${round} round, ${totalFail} fail) — sunucu/bot havuzu sorunu, bakiye iade edildi`
				: null;

			const tr = transitionTransactionStatus(
				tx.id,
				['pending', 'processing', 'resuming'],
				finalStatus,
				{ refund: false, errorType, errorMessage }
			);
			if (tr.changed) {
				db.prepare(
					`UPDATE transactions SET progress = ?, processing_time_ms = ? WHERE id = ?`
				).run(finalProgress, processingTime, tx.id);
				if (finalStatus === 'partial'
					|| finalStatus === 'failed'
					|| (finalStatus === 'completed' && finalProgress < tx.total)) {
					const refund = tx.total - finalProgress;
					if (refund > 0) {
						db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(refund, tx.user_id);
						const label = finalStatus === 'failed' ? 'Failed' : (finalStatus === 'partial' ? 'Partial' : 'Completed-with-delta');
						this.log.info(`Transaction #${tx.id}: ${label} — ${refund} övgü bakiyeye iade edildi`);
					}
				}
			} else {
				this.log.warn(`Transaction #${tx.id}: completion skipped, already finalized (status=${tr.previousStatus})`);
			}
		}

		this._stats.totalProcessed++;
		this._stats.totalCommendSuccess += totalSuccess;
		this._stats.totalCommendFail += totalFail;
		if (finalStatus === 'completed') this._stats.totalSuccess++;
		else this._stats.totalFailed++;
		this._recordProcessingTime(processingTime);

		this._broadcast('transactionUpdate', {
			id: tx.id,
			status: finalStatus,
			progress: finalProgress,
			total: tx.total,
			success: totalSuccess,
			fail: totalFail,
			processingTimeMs: processingTime,
			commendsBefore: commendsBefore,
			commendsAfter: commendsAfter,
			verifiedDelivered: verifiedDelivered
		});

		this.log.success(
			`Transaction #${tx.id} ${finalStatus}: ${finalProgress}/${tx.total} ` +
			`(${(processingTime / 1000).toFixed(1)}s)` +
			(verifiedDelivered !== null ? ` [doğrulanmış: ${verifiedDelivered}]` : '')
		);

		if (finalStatus === 'completed') {
			this._fireHook('onTransactionComplete', tx, {
				success: totalSuccess,
				fail: totalFail,
				total: tx.total,
				processingTimeMs: processingTime
			});
		} else {
			this._fireHook('onTransactionFail', tx, {
				error: 'Insufficient bots for target',
				errorType: ERROR_TYPES.BOT_ERROR,
				processingTimeMs: processingTime
			});
		}

		this._sendAllWebhooks('transaction_' + finalStatus, {
			id: tx.id,
			steamId: tx.steam_id,
			success: totalSuccess,
			fail: totalFail,
			total: tx.total,
			processingTimeMs: processingTime,
			priority: PRIORITY_NAMES[tx.priority] || 'normal'
		});
	}

	_classifyError(err) {
		const msg = (err.message || '').toLowerCase();

		if (msg.includes('rate limit') || msg.includes('too many') || msg.includes('cooldown')) {
			return ERROR_TYPES.RATE_LIMIT;
		}
		if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('econnrefused') ||
		    msg.includes('enotfound') || msg.includes('socket') || msg.includes('network')) {
			return ERROR_TYPES.NETWORK_ERROR;
		}
		if (msg.includes('invalid steam') || msg.includes('cannot parse') || msg.includes('target') ||
		    msg.includes('profile') || msg.includes('not found')) {
			return ERROR_TYPES.TARGET_ERROR;
		}
		if (msg.includes('bot') || msg.includes('gc') || msg.includes('login') ||
		    msg.includes('disconnected') || msg.includes('not ready')) {
			return ERROR_TYPES.BOT_ERROR;
		}
		return ERROR_TYPES.UNKNOWN;
	}

	_trackError(errorType, err, txId) {
		this._errorCounts[errorType] = (this._errorCounts[errorType] || 0) + 1;

		this._recentErrors.push({
			type: errorType,
			message: err.message,
			txId,
			timestamp: Date.now()
		});

		if (this._recentErrors.length > 100) {
			this._recentErrors = this._recentErrors.slice(-100);
		}
	}

	_updateAdaptiveDelay() {
		const now = Date.now();
		const windowMs = 60000;

		this._successWindow = this._successWindow.filter(t => now - t < windowMs);
		this._failWindow = this._failWindow.filter(t => now - t < windowMs);
		this._stats.commendsPerMinuteWindow = this._stats.commendsPerMinuteWindow.filter(t => now - t < windowMs);

		const totalRecent = this._successWindow.length + this._failWindow.length;
		if (totalRecent < 5) {
			this._adaptiveDelay = this.delayBetweenCommends;
			return;
		}

		const successRate = this._successWindow.length / totalRecent;

		const rateLimitedCount = this.manager.bots.filter(b => b.isOnCooldown).length;
		const totalBots = this.manager.bots.length;
		const rateLimitRatio = totalBots > 0 ? rateLimitedCount / totalBots : 0;

		let multiplier = 1;

		if (rateLimitRatio > 0.5) {
			multiplier = 4;
		} else if (rateLimitRatio > 0.3) {
			multiplier = 2.5;
		} else if (rateLimitRatio > 0.1) {
			multiplier = 1.5;
		}

		if (successRate < 0.3) {
			multiplier = Math.max(multiplier, 3);
		} else if (successRate < 0.5) {
			multiplier = Math.max(multiplier, 2);
		} else if (successRate < 0.7) {
			multiplier = Math.max(multiplier, 1.5);
		}

		this._adaptiveDelay = Math.round(this.delayBetweenCommends * multiplier);

		this._adaptiveDelay = Math.max(100, Math.min(this._adaptiveDelay, 10000));
	}

	_logCommendAttempt(txId, progress) {
		const entry = {
			txId,
			timestamp: Date.now(),
			success: progress.success,
			fail: progress.fail,
			current: progress.current,
			total: progress.total
		};

		this._commendLog.push(entry);
		if (this._commendLog.length > 500) {
			this._commendLog = this._commendLog.slice(-500);
		}
	}

	_recordProcessingTime(ms) {
		this._stats.processingTimes.push(ms);
		if (this._stats.processingTimes.length > 100) {
			this._stats.processingTimes = this._stats.processingTimes.slice(-100);
		}
	}

	_sendAllWebhooks(event, data) {
		for (const url of this._webhookUrls) {
			this._sendWebhookWithRetry(url, event, data, 0);
		}
	}

	_sendWebhookWithRetry(url, event, data, attempt) {
		const isDiscord = this.discordWebhookFormat || url.includes('discord.com/api/webhooks');

		let payload;
		if (isDiscord) {
			payload = JSON.stringify(this._buildDiscordPayload(event, data));
		} else {
			payload = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
		}

		const parsedUrl = new URL(url);
		const transport = parsedUrl.protocol === 'https:' ? https : http;

		const req = transport.request(parsedUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(payload)
			}
		}, (res) => {
			res.resume();

			if (res.statusCode >= 400) {
				this._handleWebhookFailure(url, event, data, attempt,
					new Error(`HTTP ${res.statusCode}`));
			}
		});

		req.on('error', (err) => {
			this._handleWebhookFailure(url, event, data, attempt, err);
		});

		req.write(payload);
		req.end();
	}

	_handleWebhookFailure(url, event, data, attempt, err) {
		if (attempt < this.webhookRetries - 1) {
			const delay = Math.pow(2, attempt) * 1000;
			this.log.warn(`Webhook failed (attempt ${attempt + 1}/${this.webhookRetries}): ${err.message}, retrying in ${delay}ms`);
			setTimeout(() => {
				this._sendWebhookWithRetry(url, event, data, attempt + 1);
			}, delay);
		} else {
			this.log.error(`Webhook permanently failed after ${this.webhookRetries} attempts: ${err.message}`);
		}
	}

	_buildDiscordPayload(event, data) {
		const colorMap = {
			transaction_completed: 0x2ECC71,
			transaction_failed: 0xE74C3C,
			transaction_processing: 0xF39C12
		};

		const fields = Object.entries(data)
			.filter(([, v]) => v !== null && v !== undefined)
			.map(([k, v]) => ({
				name: k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
				value: String(v),
				inline: true
			}));

		return {
			embeds: [{
				title: event.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
				color: colorMap[event] || 0x3498DB,
				fields,
				timestamp: new Date().toISOString(),
				footer: { text: 'CS2 Commend Bot' }
			}]
		};
	}

	_parseAccountId(steamIdStr) {
		const SteamID = require('steamid');

		const match = steamIdStr.match(/steamcommunity\.com\/(profiles|id)\/([^\/\?]+)/i);
		if (match) {
			if (match[1] === 'profiles') {
				const sid = new SteamID(match[2]);
				return sid.accountid;
			}
			throw new Error('Vanity URL desteklenmiyor. Lütfen SteamID64 veya /profiles/ bağlantısı kullanın: ' + steamIdStr);
		}

		try {
			const sid = new SteamID(steamIdStr);
			if (sid.isValid()) return sid.accountid;
		} catch {}

		const num = parseInt(steamIdStr);
		if (!isNaN(num) && num > 0) return num;

		throw new Error('Geçersiz Steam ID. SteamID64 (76561198...) veya profil bağlantısı (/profiles/) kullanın: ' + steamIdStr);
	}

	getStatus() {
		const pending = stmts.pendingCount.get();
		const processing = stmts.processingCount.get();

		return {
			isProcessing: this._activeTransactions.size > 0,
			activeCount: this._activeTransactions.size,
			concurrency: this.concurrency,
			pendingCount: pending.count,
			processingCount: processing.count,
			sseClients: this._sseClients.size,
			adaptiveDelay: this._adaptiveDelay,
			botStatus: this.manager.status
		};
	}

	getDetailedStats() {
		const now = Date.now();
		const uptimeMs = now - this._stats.startTime;

		const oneMinuteAgo = now - 60000;
		this._stats.commendsPerMinuteWindow = this._stats.commendsPerMinuteWindow.filter(t => t > oneMinuteAgo);

		const avgProcessingTime = this._stats.processingTimes.length > 0
			? Math.round(this._stats.processingTimes.reduce((a, b) => a + b, 0) / this._stats.processingTimes.length)
			: 0;

		const sortedTimes = [...this._stats.processingTimes].sort((a, b) => a - b);
		const fastestProcessing = sortedTimes.length > 0 ? sortedTimes[0] : 0;
		const slowestProcessing = sortedTimes.length > 0 ? sortedTimes[sortedTimes.length - 1] : 0;

		const totalAttempts = this._stats.totalCommendSuccess + this._stats.totalCommendFail;
		const successRate = totalAttempts > 0
			? ((this._stats.totalCommendSuccess / totalAttempts) * 100).toFixed(1)
			: 'N/A';

		const txCountable = this._stats.totalSuccess + this._stats.totalFailed;
		const txSuccessRate = txCountable > 0
			? ((this._stats.totalSuccess / txCountable) * 100).toFixed(1)
			: 'N/A';

		const fiveMinAgo = now - 300000;
		const recentErrors = this._recentErrors.filter(e => e.timestamp > fiveMinAgo);
		const errorFrequency = {};
		for (const e of recentErrors) {
			errorFrequency[e.type] = (errorFrequency[e.type] || 0) + 1;
		}

		return {
			uptime: uptimeMs,
			uptimeFormatted: this._formatDuration(uptimeMs),

			transactions: {
				totalProcessed: this._stats.totalProcessed,
				totalSuccess: this._stats.totalSuccess,
				totalFailed: this._stats.totalFailed,
				totalUserError: this._stats.totalUserError,
				txSuccessRate: txSuccessRate + '%',
				currentlyActive: this._activeTransactions.size,
				concurrency: this.concurrency
			},

			commends: {
				totalAttempts,
				totalSuccess: this._stats.totalCommendSuccess,
				totalFail: this._stats.totalCommendFail,
				successRate: successRate + '%',
				commendsPerMinute: this._stats.commendsPerMinuteWindow.length,
				adaptiveDelayMs: this._adaptiveDelay
			},

			timing: {
				avgProcessingTimeMs: avgProcessingTime,
				fastestProcessingMs: fastestProcessing,
				slowestProcessingMs: slowestProcessing
			},

			errors: {
				totalByType: { ...this._errorCounts },
				recentErrors5min: recentErrors.length,
				errorFrequency5min: errorFrequency,
				patterns: this._detectErrorPatterns()
			},

			rateLimit: {
				rateLimitedBots: this.manager.bots.filter(b => b.isOnCooldown).length,
				totalBots: this.manager.bots.length,
				adaptiveDelayMs: this._adaptiveDelay,
				baseDelayMs: this.delayBetweenCommends
			},

			webhooks: {
				urls: this._webhookUrls.length,
				discordFormat: this.discordWebhookFormat
			},

			sse: {
				connectedClients: this._sseClients.size
			}
		};
	}

	_detectErrorPatterns() {
		const patterns = [];
		const now = Date.now();
		const fiveMinAgo = now - 300000;
		const recent = this._recentErrors.filter(e => e.timestamp > fiveMinAgo);

		if (recent.length === 0) return patterns;

		const rateLimitRecent = recent.filter(e => e.type === ERROR_TYPES.RATE_LIMIT);
		if (rateLimitRecent.length >= 5) {
			patterns.push({
				type: 'rate_limit_surge',
				message: `${rateLimitRecent.length} rate limit errors in last 5 minutes`,
				severity: 'high'
			});
		}

		const networkRecent = recent.filter(e => e.type === ERROR_TYPES.NETWORK_ERROR);
		if (networkRecent.length >= 3) {
			patterns.push({
				type: 'network_instability',
				message: `${networkRecent.length} network errors in last 5 minutes`,
				severity: 'medium'
			});
		}

		if (recent.length >= 10) {
			patterns.push({
				type: 'high_error_rate',
				message: `${recent.length} total errors in last 5 minutes`,
				severity: 'high'
			});
		}

		return patterns;
	}

	_formatDuration(ms) {
		const seconds = Math.floor(ms / 1000) % 60;
		const minutes = Math.floor(ms / 60000) % 60;
		const hours = Math.floor(ms / 3600000);
		return `${hours}h ${minutes}m ${seconds}s`;
	}

	getCommendLog(limit = 50) {
		return this._commendLog.slice(-limit);
	}

	getErrorSummary() {
		return {
			totalByType: { ...this._errorCounts },
			recentErrors: this._recentErrors.slice(-20),
			patterns: this._detectErrorPatterns()
		};
	}
}

module.exports = TransactionProcessor;
