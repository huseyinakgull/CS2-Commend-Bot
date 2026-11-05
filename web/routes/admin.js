const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { safeEqual } = require('../lib/password');
const db = require('../database');
const { transitionTransactionStatus, getSetting, setSetting } = require('../database');
const { verifyAdmin, logEvent, eventLog, requestLog, blockedIPs } = require('../middleware/auth');

const router = express.Router();
router.use(verifyAdmin);

function likeEscape(str) {
	return String(str).replace(/[\\%_]/g, '\\$&');
}

const auditLog = [];
function audit(action, details, req) {
	const entry = {
		timestamp: new Date().toISOString(),
		action,
		ip: req.ip || req.socket.remoteAddress,
		details: details || {}
	};
	auditLog.push(entry);
	if (auditLog.length > 5000) auditLog.splice(0, auditLog.length - 5000);
	logEvent('audit', `${action}: ${JSON.stringify(details || {})}`, { ip: entry.ip });
	try {
		db.prepare(
			`INSERT INTO audit_log (action, actor, target_id, target_type, details, ip) VALUES (?, 'admin', ?, ?, ?, ?)`
		).run(
			action,
			details && details.targetId ? String(details.targetId) : null,
			details && details.targetType ? details.targetType : null,
			JSON.stringify(details || {}),
			entry.ip
		);
	} catch {}
}

function bm(req) { return req.app.locals.botManager; }
function tp(req) { return req.app.locals.transactionProcessor; }

router.get('/overview', (req, res) => {
	const totalCodes = db.prepare('SELECT COUNT(*) as c FROM codes').get().c;
	const usedCodes = db.prepare('SELECT COUNT(*) as c FROM codes WHERE is_used = 1').get().c;
	const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
	const bannedUsers = db.prepare('SELECT COUNT(*) as c FROM users WHERE banned = 1').get().c;

	const txByStatus = db.prepare(
		`SELECT status, COUNT(*) as c FROM transactions GROUP BY status`
	).all().reduce((acc, r) => ({ ...acc, [r.status]: r.c }), {});

	const totalCommendsSent = db.prepare('SELECT COALESCE(SUM(progress),0) as t FROM transactions').get().t;
	const totalVerifiedDelivered = db.prepare(
		`SELECT COALESCE(SUM(verified_delivered), 0) as t FROM transactions WHERE verified_delivered IS NOT NULL`
	).get().t;
	const verifiableCount = db.prepare(
		`SELECT COUNT(*) as c FROM transactions WHERE verified_delivered IS NOT NULL`
	).get().c;

	const tx24h = db.prepare(
		`SELECT COUNT(*) as c FROM transactions WHERE created_at >= datetime('now', '-1 day')`
	).get().c;
	const commends24h = db.prepare(
		`SELECT COALESCE(SUM(progress),0) as t FROM transactions WHERE created_at >= datetime('now', '-1 day')`
	).get().t;

	const activeUsers24h = db.prepare(
		`SELECT COUNT(*) as c FROM users WHERE last_active >= datetime('now', '-1 day')`
	).get().c;

	const totalBalanceInCirculation = db.prepare('SELECT COALESCE(SUM(balance),0) as t FROM users').get().t;
	const totalDistributed = db.prepare(
		`SELECT COALESCE(SUM(initial_balance - balance), 0) as t FROM codes WHERE is_used = 1`
	).get().t;

	const completed = txByStatus.completed || 0;
	const failed = txByStatus.failed || 0;
	const userErrorFailed = db.prepare(
		`SELECT COUNT(*) as c FROM transactions WHERE status = 'failed' AND error_type = 'target_error'`
	).get().c;
	const systemFailed = Math.max(0, failed - userErrorFailed);
	const totalFinished = completed + systemFailed;
	const successRate = totalFinished > 0 ? Math.round((completed / totalFinished) * 10000) / 100 : 0;

	const freeByStatus = db.prepare(
		`SELECT status, COUNT(*) as c FROM free_commends GROUP BY status`
	).all().reduce((acc, r) => ({ ...acc, [r.status]: r.c }), {});

	const recentAudit = [...auditLog].reverse().slice(0, 10);

	const manager = bm(req);
	const botStatus = manager ? {
		available: true,
		...manager.status,
		connectedPlayers: manager._connectedPlayers ? manager._connectedPlayers.size : null,
		logListenerReady: !!manager._logListenerReady,
		busyCount: manager._busyAccounts ? manager._busyAccounts.size : 0,
		poolHealth: typeof manager.getBotPoolHealth === 'function' ? manager.getBotPoolHealth() : null
	} : { available: false };

	const processor = tp(req);
	const processorStatus = processor ? { available: true, ...processor.getStatus() } : { available: false };

	const memUsage = process.memoryUsage();

	res.json({
		codes: { total: totalCodes, used: usedCodes, unused: totalCodes - usedCodes },
		users: { total: totalUsers, banned: bannedUsers, active24h: activeUsers24h },
		transactions: {
			total: Object.values(txByStatus).reduce((a, b) => a + b, 0),
			byStatus: txByStatus,
			today: tx24h,
			successRate,
			userErrorFailed,
			systemFailed
		},
		commends: {
			totalSent: totalCommendsSent,
			verifiedDelivered: totalVerifiedDelivered,
			verifiableCount,
			today: commends24h
		},
		balance: { inCirculation: totalBalanceInCirculation, distributed: totalDistributed },
		freeCommends: freeByStatus,
		botStatus,
		processorStatus,
		system: {
			uptime: process.uptime(),
			memory: { rss: memUsage.rss, heapUsed: memUsage.heapUsed, heapTotal: memUsage.heapTotal },
			nodeVersion: process.version,
			platform: process.platform
		},
		recentAudit
	});
});

router.get('/analytics', (req, res) => {
	const rawDaily = db.prepare(
		`SELECT DATE(created_at) as date,
		        COUNT(*) as count,
		        COALESCE(SUM(progress), 0) as commends
		 FROM transactions
		 WHERE created_at >= DATE('now', '-7 days')
		 GROUP BY DATE(created_at)`
	).all();
	const dailyMap = {};
	rawDaily.forEach(d => { dailyMap[d.date] = d; });
	const dailyTransactions = [];
	for (let i = 6; i >= 0; i--) {
		const d = new Date(); d.setDate(d.getDate() - i);
		const key = d.toISOString().slice(0, 10);
		dailyTransactions.push({
			date: key,
			count: dailyMap[key]?.count || 0,
			commends: dailyMap[key]?.commends || 0
		});
	}

	const hourlyTransactions = db.prepare(
		`SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour, COUNT(*) as count
		 FROM transactions WHERE created_at >= DATE('now') GROUP BY hour`
	).all();

	const commendTypes = db.prepare(
		`SELECT COALESCE(SUM(friendly),0) as friendly,
		        COALESCE(SUM(teaching),0) as teaching,
		        COALESCE(SUM(leader),0)   as leader
		 FROM transactions`
	).get();

	const errorBreakdown = db.prepare(
		`SELECT COALESCE(error_type, 'unknown') as error_type, COUNT(*) as count
		 FROM transactions WHERE status = 'failed' GROUP BY error_type ORDER BY count DESC`
	).all();

	const topUsers = db.prepare(
		`SELECT u.id, u.steam_id, u.steam_name, COUNT(t.id) as txCount, COALESCE(SUM(t.progress),0) as commends
		 FROM users u JOIN transactions t ON t.user_id = u.id
		 GROUP BY u.id ORDER BY txCount DESC LIMIT 10`
	).all();

	const verificationStats = db.prepare(
		`SELECT
		   COUNT(*) as totalVerifiable,
		   COALESCE(SUM(progress), 0) as totalProgress,
		   COALESCE(SUM(verified_delivered), 0) as totalDelivered
		 FROM transactions
		 WHERE status = 'completed' AND verified_delivered IS NOT NULL`
	).get();

	const avgProcessingTime = db.prepare(
		`SELECT AVG(processing_time_ms) as avg FROM transactions
		 WHERE processing_time_ms IS NOT NULL AND created_at >= datetime('now', '-7 days')`
	).get().avg || 0;

	res.json({
		dailyTransactions,
		hourlyTransactions,
		commendTypes,
		errorBreakdown,
		topUsers,
		verification: verificationStats,
		avgProcessingTimeMs: Math.round(avgProcessingTime)
	});
});

function generateCode() {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	const bytes = crypto.randomBytes(12);
	let code = '';
	for (let i = 0; i < 12; i++) {
		if (i > 0 && i % 4 === 0) code += '-';
		code += chars[bytes[i] % chars.length];
	}
	return code;
}

router.post('/codes/generate', (req, res) => {
	let { count, balance, expiresAt, productType } = req.body;
	count = parseInt(count);
	balance = parseInt(balance);
	if (!count || count <= 0 || count > 100) return res.status(400).json({ error: 'Adet 1-100 arası olmalı' });
	if (!balance || balance <= 0) return res.status(400).json({ error: 'Bakiye 0\'dan büyük olmalı' });

	const pt = ['commend', 'hours', 'group'].includes(productType) ? productType : 'commend';

	const codes = [];
	const insert = db.prepare('INSERT INTO codes (code, balance, initial_balance, expires_at, product_type) VALUES (?, ?, ?, ?, ?)');
	const insertMany = db.transaction(() => {
		for (let i = 0; i < count; i++) {
			let code = generateCode();
			let tries = 0;
			while (tries < 5) {
				try { insert.run(code, balance, balance, expiresAt || null, pt); codes.push({ code, balance, productType: pt }); break; }
				catch { code = generateCode(); tries++; }
			}
		}
	});
	insertMany();
	audit('codes_generated', { count: codes.length, balance, expiresAt, productType: pt }, req);
	res.json({ codes, generated: codes.length });
});

router.get('/codes', (req, res) => {
	const page = parseInt(req.query.page) || 1;
	const limit = Math.min(parseInt(req.query.limit) || 20, 100);
	const offset = (page - 1) * limit;
	const filter = req.query.filter || 'all';
	const search = (req.query.search || '').trim();

	let where = '1=1';
	const params = [];
	if (filter === 'used') where += ' AND c.is_used = 1';
	else if (filter === 'unused') where += ' AND c.is_used = 0';
	else if (filter === 'expired') where += " AND c.expires_at IS NOT NULL AND c.expires_at < datetime('now')";
	if (search) {
		where += " AND (c.code LIKE ? ESCAPE '\\' OR u.steam_id LIKE ? ESCAPE '\\' OR u.steam_name LIKE ? ESCAPE '\\')";
		const p = `%${likeEscape(search)}%`;
		params.push(p, p, p);
	}

	const codes = db.prepare(
		`SELECT c.*, u.id as user_id, u.steam_id, u.steam_name
		 FROM codes c LEFT JOIN users u ON u.code_id = c.id
		 WHERE ${where}
		 ORDER BY c.created_at DESC LIMIT ? OFFSET ?`
	).all(...params, limit, offset);

	const total = db.prepare(
		`SELECT COUNT(*) as c FROM codes c LEFT JOIN users u ON u.code_id = c.id WHERE ${where}`
	).get(...params).c;

	res.json({
		codes: codes.map(c => ({
			id: c.id, code: c.code, balance: c.balance, initialBalance: c.initial_balance,
			isUsed: !!c.is_used, steamId: c.steam_id, steamName: c.steam_name, userId: c.user_id,
			createdAt: c.created_at, expiresAt: c.expires_at,
			productType: c.product_type || 'commend'
		})),
		total, page, totalPages: Math.ceil(total / limit)
	});
});

router.get('/codes/export', (req, res) => {
	const codes = db.prepare('SELECT code, balance FROM codes WHERE is_used = 0 ORDER BY created_at DESC').all();
	audit('codes_exported', { count: codes.length }, req);
	res.json(codes);
});

router.delete('/codes/:id', (req, res) => {
	const code = db.prepare('SELECT * FROM codes WHERE id = ?').get(req.params.id);
	if (!code) return res.status(404).json({ error: 'Kod bulunamadı' });
	if (code.code === 'FREE-SYSTEM-CODE') return res.status(403).json({ error: 'Sistem kodu silinemez' });

	const deleteTx = db.transaction(() => {
		if (code.is_used) {
			const user = db.prepare('SELECT id, steam_id FROM users WHERE code_id = ?').get(code.id);
			if (user) {
				if (user.steam_id === '__FREE_SYSTEM__') throw new Error('Sistem kullanıcısı silinemez');
				db.prepare('DELETE FROM free_commends WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = ?)').run(user.id);
				db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
				db.prepare('DELETE FROM promo_redemptions WHERE user_id = ?').run(user.id);
				db.prepare('DELETE FROM transactions WHERE user_id = ?').run(user.id);
				db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
			}
		}
		db.prepare('DELETE FROM codes WHERE id = ?').run(code.id);
	});
	try { deleteTx(); }
	catch (err) {
		console.error('[admin/codes/delete]', err);
		return res.status(403).json({ error: 'Kod silinemedi (bağlı kayıtlar var)' });
	}

	audit('code_deleted', { codeId: code.id, code: code.code, wasUsed: !!code.is_used }, req);
	res.json({ success: true });
});

router.post('/codes/bulk-delete', (req, res) => {
	const { ids, filter } = req.body;
	if (ids && Array.isArray(ids)) {
		const del = db.prepare('DELETE FROM codes WHERE id = ? AND is_used = 0');
		const run = db.transaction(arr => { let n = 0; for (const id of arr) n += del.run(id).changes; return n; });
		const deleted = run(ids);
		audit('codes_bulk_deleted', { deleted, ids: ids.length }, req);
		return res.json({ success: true, deleted });
	}
	if (filter === 'unused') {
		const r = db.prepare('DELETE FROM codes WHERE is_used = 0').run();
		audit('codes_bulk_deleted', { filter: 'unused', deleted: r.changes }, req);
		return res.json({ success: true, deleted: r.changes });
	}
	if (filter === 'expired') {
		const r = db.prepare("DELETE FROM codes WHERE is_used = 0 AND expires_at IS NOT NULL AND expires_at < datetime('now')").run();
		audit('codes_bulk_deleted', { filter: 'expired', deleted: r.changes }, req);
		return res.json({ success: true, deleted: r.changes });
	}
	res.status(400).json({ error: 'ids veya filter gerekli' });
});

router.get('/users', (req, res) => {
	const page = parseInt(req.query.page) || 1;
	const limit = Math.min(parseInt(req.query.limit) || 20, 100);
	const offset = (page - 1) * limit;
	const search = (req.query.search || '').trim();
	const filter = req.query.filter || 'all';

	let where = '1=1';
	const params = [];
	if (search) {
		where += " AND (u.steam_id LIKE ? ESCAPE '\\' OR u.steam_name LIKE ? ESCAPE '\\' OR c.code LIKE ? ESCAPE '\\')";
		const p = `%${likeEscape(search)}%`;
		params.push(p, p, p);
	}
	if (filter === 'banned') where += ' AND u.banned = 1';
	else if (filter === 'active24h') where += " AND u.last_active >= datetime('now', '-1 day')";

	const users = db.prepare(
		`SELECT u.*, c.code, c.initial_balance as code_initial_balance,
		        (SELECT COUNT(*) FROM transactions t WHERE t.user_id = u.id) as tx_count,
		        (SELECT COALESCE(SUM(progress),0) FROM transactions t WHERE t.user_id = u.id) as total_commends
		 FROM users u JOIN codes c ON c.id = u.code_id
		 WHERE ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`
	).all(...params, limit, offset);

	const total = db.prepare(
		`SELECT COUNT(*) as c FROM users u JOIN codes c ON c.id = u.code_id WHERE ${where}`
	).get(...params).c;

	res.json({
		users: users.map(u => ({
			id: u.id, code: u.code, steamId: u.steam_id, steamName: u.steam_name,
			balance: u.balance, initialBalance: u.code_initial_balance,
			banned: !!u.banned, createdAt: u.created_at, lastActive: u.last_active,
			txCount: u.tx_count, totalCommends: u.total_commends
		})),
		total, page, totalPages: Math.ceil(total / limit)
	});
});

router.get('/users/:id', (req, res) => {
	const user = db.prepare(
		`SELECT u.*, c.code, c.initial_balance as code_initial_balance
		 FROM users u JOIN codes c ON c.id = u.code_id WHERE u.id = ?`
	).get(req.params.id);
	if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

	const transactions = db.prepare(
		'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
	).all(user.id);

	const sessions = db.prepare(
		`SELECT id, ip, user_agent, created_at, expires_at, is_active FROM sessions
		 WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`
	).all(user.id);

	const auditEntries = db.prepare(
		`SELECT * FROM audit_log WHERE target_id = ? AND target_type = 'user'
		 ORDER BY created_at DESC LIMIT 50`
	).all(String(user.id));

	res.json({ user, transactions, sessions, audit: auditEntries });
});

router.patch('/users/:id/balance', (req, res) => {
	const { balance, delta } = req.body;
	const userId = req.params.id;
	const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
	if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

	let newBalance;
	if (typeof delta === 'number') newBalance = Math.max(0, user.balance + delta);
	else if (typeof balance === 'number' && balance >= 0) newBalance = balance;
	else return res.status(400).json({ error: 'Geçerli balance veya delta gerekli' });

	db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBalance, userId);
	audit('user_balance_changed', {
		targetId: userId, targetType: 'user',
		oldBalance: user.balance, newBalance
	}, req);
	res.json({ success: true, oldBalance: user.balance, newBalance });
});

router.patch('/users/:id/ban', (req, res) => {
	const { banned } = req.body;
	const userId = req.params.id;
	const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
	if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

	db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(banned ? 1 : 0, userId);
	if (banned) {
		db.prepare('UPDATE sessions SET is_active = 0 WHERE user_id = ?').run(userId);
	}
	audit(banned ? 'user_banned' : 'user_unbanned', { targetId: userId, targetType: 'user' }, req);
	res.json({ success: true, banned: !!banned });
});

router.delete('/users/:id/sessions/:sid', (req, res) => {
	const r = db.prepare('UPDATE sessions SET is_active = 0 WHERE id = ? AND user_id = ?').run(
		req.params.sid, req.params.id
	);
	if (r.changes === 0) return res.status(404).json({ error: 'Oturum bulunamadı' });
	audit('session_revoked', { targetId: req.params.id, targetType: 'user', sessionId: req.params.sid }, req);
	res.json({ success: true });
});

router.get('/transactions', (req, res) => {
	const page = parseInt(req.query.page) || 1;
	const limit = Math.min(parseInt(req.query.limit) || 20, 100);
	const offset = (page - 1) * limit;
	const status = req.query.status || '';
	const search = (req.query.search || '').trim();
	const errorType = req.query.errorType || '';
	const dateFrom = req.query.dateFrom || '';
	const dateTo = req.query.dateTo || '';

	let where = '1=1';
	const params = [];
	if (status) {
		const statuses = status.split(',').filter(Boolean);
		if (statuses.length > 0) {
			where += ` AND t.status IN (${statuses.map(() => '?').join(',')})`;
			params.push(...statuses);
		}
	}
	if (search) {
		where += " AND (t.steam_id LIKE ? ESCAPE '\\' OR u.steam_name LIKE ? ESCAPE '\\' OR c.code LIKE ? ESCAPE '\\')";
		const p = `%${likeEscape(search)}%`;
		params.push(p, p, p);
	}
	if (errorType) { where += ' AND t.error_type = ?'; params.push(errorType); }
	if (dateFrom) { where += ' AND t.created_at >= ?'; params.push(dateFrom); }
	if (dateTo) { where += ' AND t.created_at <= ?'; params.push(dateTo); }

	const transactions = db.prepare(
		`SELECT t.*, u.steam_name as user_steam_name, c.code
		 FROM transactions t
		 JOIN users u ON u.id = t.user_id
		 JOIN codes c ON c.id = u.code_id
		 WHERE ${where}
		 ORDER BY t.created_at DESC LIMIT ? OFFSET ?`
	).all(...params, limit, offset);

	const total = db.prepare(
		`SELECT COUNT(*) as c FROM transactions t
		 JOIN users u ON u.id = t.user_id
		 JOIN codes c ON c.id = u.code_id
		 WHERE ${where}`
	).get(...params).c;

	res.json({
		transactions: transactions.map(t => ({
			id: t.id, code: t.code, userSteamName: t.user_steam_name,
			steamId: t.steam_id, friendly: t.friendly, teaching: t.teaching, leader: t.leader,
			total: t.total, progress: t.progress, status: t.status, priority: t.priority,
			errorType: t.error_type, errorMessage: t.error_message,
			retryCount: t.retry_count, commendsBefore: t.commends_before,
			commendsAfter: t.commends_after, verifiedDelivered: t.verified_delivered,
			processingTimeMs: t.processing_time_ms,
			createdAt: t.created_at, startedAt: t.started_at, completedAt: t.completed_at
		})),
		total, page, totalPages: Math.ceil(total / limit)
	});
});

router.get('/transactions/:id', (req, res) => {
	const tx = db.prepare(
		`SELECT t.*, u.steam_name as user_steam_name, u.id as user_id, c.code
		 FROM transactions t
		 JOIN users u ON u.id = t.user_id
		 JOIN codes c ON c.id = u.code_id
		 WHERE t.id = ?`
	).get(req.params.id);
	if (!tx) return res.status(404).json({ error: 'İşlem bulunamadı' });
	res.json({ transaction: tx });
});

router.post('/manual-order', async (req, res) => {
	try {
		const { steamId, steamUrl, total, friendly, teaching, leader, note, source } = req.body || {};
		const inputSid = (steamId || steamUrl || '').trim();
		if (!inputSid) return res.status(400).json({ error: 'steamId veya steamUrl gerekli' });

		const totalNum = parseInt(total, 10);
		if (!Number.isFinite(totalNum) || totalNum < 1 || totalNum > 5000) {
			return res.status(400).json({ error: 'total 1-5000 arası bir sayı olmalı' });
		}

		const steamApiKey = req.app.locals.steamApiKey;
		const { parseSteamId } = require('../lib/steam-ids');
		const steamId64 = await parseSteamId(inputSid, steamApiKey);
		if (!steamId64) return res.status(400).json({ error: 'Geçersiz Steam ID veya profil URL' });

		const f = Math.max(0, parseInt(friendly, 10) || totalNum);
		const t = Math.max(0, parseInt(teaching, 10) || totalNum);
		const l = Math.max(0, parseInt(leader, 10) || totalNum);

		let adminUser = db.prepare("SELECT id FROM users WHERE steam_id = '__MANUAL_ADMIN__'").get();
		if (!adminUser) {
			db.prepare("INSERT OR IGNORE INTO codes (code, balance, initial_balance, is_used) VALUES ('MANUAL-ADMIN-CODE', 0, 0, 1)").run();
			const code = db.prepare("SELECT id FROM codes WHERE code = 'MANUAL-ADMIN-CODE'").get();
			db.prepare("INSERT OR IGNORE INTO users (code_id, steam_id, steam_name, balance) VALUES (?, '__MANUAL_ADMIN__', 'Manuel Admin Sipariş', 0)").run(code.id);
			adminUser = db.prepare("SELECT id FROM users WHERE steam_id = '__MANUAL_ADMIN__'").get();
		}

		const txResult = db.prepare(
			"INSERT INTO transactions (user_id, steam_id, friendly, teaching, leader, total, status, priority) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0)"
		).run(adminUser.id, steamId64, f, t, l, totalNum);

		const txId = txResult.lastInsertRowid;
		audit('manual_order_created', {
			txId, steamId: steamId64, total: totalNum, friendly: f, teaching: t, leader: l,
			source: source || null, note: note || null
		}, req);

		res.json({
			success: true,
			transactionId: txId,
			steamId: steamId64,
			total: totalNum,
			friendly: f, teaching: t, leader: l,
			message: 'TX oluşturuldu, processor kuyruğa aldı'
		});
	} catch (err) {
		console.error('[admin/manual-order]', err);
		res.status(500).json({ error: 'Manuel sipariş oluşturulamadı' });
	}
});

router.post('/transactions/:id/retry', (req, res) => {
	const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
	if (!tx) return res.status(404).json({ error: 'İşlem bulunamadı' });
	if (!['failed', 'cancelled'].includes(tx.status)) {
		return res.status(400).json({ error: 'Yalnızca başarısız/iptal edilmiş işlemler yeniden denenebilir' });
	}

	const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(tx.user_id);
	const remaining = tx.total - (tx.progress || 0);
	if (!user || user.balance < remaining) {
		return res.status(400).json({ error: `Retry için yetersiz bakiye (ihtiyaç: ${remaining}, mevcut: ${user?.balance || 0})` });
	}

	const doRetry = db.transaction(() => {
		db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?').run(remaining, tx.user_id, remaining);
		db.prepare(
			`UPDATE transactions SET status = 'pending', progress = ?, completed_at = NULL,
			 error_type = NULL, error_message = NULL, retry_count = 0 WHERE id = ?`
		).run(tx.progress || 0, tx.id);
	});
	doRetry();

	audit('transaction_retried', { targetId: tx.id, targetType: 'transaction' }, req);
	res.json({ success: true });
});

router.post('/transactions/:id/cancel', (req, res) => {
	const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
	if (!tx) return res.status(404).json({ error: 'İşlem bulunamadı' });

	const result = transitionTransactionStatus(
		tx.id,
		['pending', 'processing', 'resuming'],
		'cancelled',
		{ refund: true }
	);
	if (!result.changed) {
		return res.status(400).json({
			error: 'İşlem zaten sonlandırılmış',
			currentStatus: result.previousStatus
		});
	}
	db.prepare(`UPDATE transactions SET error_type = 'admin_cancelled', error_message = 'Admin tarafından iptal edildi' WHERE id = ?`).run(tx.id);

	const manager = bm(req);
	if (manager) {
		try {
			const SteamID = require('steamid');
			const sid = new SteamID(tx.steam_id);
			manager.cancelCommendPlayer && manager.cancelCommendPlayer(sid.accountid);
		} catch {}
	}

	audit('transaction_cancelled', {
		targetId: tx.id, targetType: 'transaction',
		refunded: result.refunded, previousStatus: result.previousStatus
	}, req);
	res.json({ success: true, refunded: result.refunded });
});

router.patch('/transactions/:id/priority', (req, res) => {
	const { priority } = req.body;
	const valid = ['normal', 'high', 'urgent'];
	const map = { normal: 0, high: 1, urgent: 2 };
	if (!valid.includes(priority)) return res.status(400).json({ error: 'Geçersiz öncelik' });

	const r = db.prepare(
		`UPDATE transactions SET priority = ? WHERE id = ? AND status IN ('pending','resuming')`
	).run(map[priority], req.params.id);
	if (r.changes === 0) return res.status(400).json({ error: 'İşlem bulunamadı veya başlamış' });
	audit('transaction_priority_changed', { targetId: req.params.id, targetType: 'transaction', priority }, req);
	res.json({ success: true });
});

router.post('/transactions/bulk-retry', (req, res) => {
	const { ids } = req.body;
	if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids gerekli' });
	let retried = 0;
	for (const id of ids) {
		const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
		if (!tx || !['failed', 'cancelled'].includes(tx.status)) continue;
		const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(tx.user_id);
		const remaining = tx.total - (tx.progress || 0);
		if (!user || user.balance < remaining) continue;
		const run = db.transaction(() => {
			db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?').run(remaining, tx.user_id, remaining);
			db.prepare(
				`UPDATE transactions SET status = 'pending', progress = ?, completed_at = NULL,
				 error_type = NULL, error_message = NULL, retry_count = 0 WHERE id = ?`
			).run(tx.progress || 0, tx.id);
		});
		run();
		retried++;
	}
	audit('transactions_bulk_retry', { total: ids.length, retried }, req);
	res.json({ success: true, retried });
});

router.post('/transactions/bulk-cancel', (req, res) => {
	const { ids } = req.body;
	if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids gerekli' });
	const manager = bm(req);
	let cancelled = 0, totalRefunded = 0;
	for (const id of ids) {
		const tx = db.prepare('SELECT steam_id FROM transactions WHERE id = ?').get(id);
		if (!tx) continue;
		const r = transitionTransactionStatus(id, ['pending', 'processing', 'resuming'], 'cancelled', { refund: true });
		if (r.changed) {
			cancelled++;
			totalRefunded += r.refunded;
			db.prepare(`UPDATE transactions SET error_type = 'admin_cancelled', error_message = 'Toplu iptal' WHERE id = ?`).run(id);
			if (manager && tx.steam_id) {
				try {
					const SteamID = require('steamid');
					const sid = new SteamID(tx.steam_id);
					manager.cancelCommendPlayer && manager.cancelCommendPlayer(sid.accountid);
				} catch {}
			}
		}
	}
	audit('transactions_bulk_cancel', { total: ids.length, cancelled, refunded: totalRefunded }, req);
	res.json({ success: true, cancelled, refunded: totalRefunded });
});

router.get('/transactions/export/csv', (req, res) => {
	const txs = db.prepare(
		`SELECT t.id, t.steam_id, t.friendly, t.teaching, t.leader, t.total, t.progress,
		        t.status, t.priority, t.error_type, t.error_message, t.retry_count,
		        t.commends_before, t.commends_after, t.verified_delivered, t.processing_time_ms,
		        t.created_at, t.completed_at, u.steam_name, c.code
		 FROM transactions t JOIN users u ON u.id = t.user_id JOIN codes c ON c.id = u.code_id
		 ORDER BY t.created_at DESC LIMIT 10000`
	).all();
	const header = 'id,steam_id,friendly,teaching,leader,total,progress,status,priority,error_type,error_message,retry_count,commends_before,commends_after,verified_delivered,processing_time_ms,created_at,completed_at,steam_name,code';
	const esc = (v) => v == null ? '' : String(v).replace(/"/g, '""');
	const lines = txs.map(t => [
		t.id, t.steam_id, t.friendly, t.teaching, t.leader, t.total, t.progress, t.status, t.priority,
		t.error_type, t.error_message, t.retry_count, t.commends_before, t.commends_after,
		t.verified_delivered, t.processing_time_ms, t.created_at, t.completed_at, t.steam_name, t.code
	].map(v => `"${esc(v)}"`).join(','));
	res.setHeader('Content-Type', 'text/csv; charset=utf-8');
	res.setHeader('Content-Disposition', 'attachment; filename=transactions.csv');
	audit('transactions_exported', { count: txs.length }, req);
	res.send('\uFEFF' + header + '\n' + lines.join('\n'));
});

router.get('/free-commends', (req, res) => {
	const page = parseInt(req.query.page) || 1;
	const limit = Math.min(parseInt(req.query.limit) || 20, 100);
	const offset = (page - 1) * limit;
	const status = req.query.status || '';
	const search = (req.query.search || '').trim();

	let where = '1=1'; const params = [];
	if (status) { where += ' AND fc.status = ?'; params.push(status); }
	if (search) { where += " AND (fc.steam_id LIKE ? ESCAPE '\\' OR fc.ip LIKE ? ESCAPE '\\')"; const p = `%${likeEscape(search)}%`; params.push(p, p); }

	const rows = db.prepare(
		`SELECT fc.*, t.status as tx_status, t.progress as tx_progress, t.error_message
		 FROM free_commends fc LEFT JOIN transactions t ON t.id = fc.transaction_id
		 WHERE ${where} ORDER BY fc.created_at DESC LIMIT ? OFFSET ?`
	).all(...params, limit, offset);

	const total = db.prepare(`SELECT COUNT(*) as c FROM free_commends fc WHERE ${where}`).get(...params).c;

	res.json({
		freeCommends: rows.map(r => ({
			id: r.id, steamId: r.steam_id, ip: r.ip,
			transactionId: r.transaction_id, status: r.status, progress: r.progress, total: r.total,
			createdAt: r.created_at, completedAt: r.completed_at,
			txStatus: r.tx_status, txProgress: r.tx_progress, errorMessage: r.error_message
		})),
		total, page, totalPages: Math.ceil(total / limit)
	});
});

router.delete('/free-commends/:id', (req, res) => {
	const fc = db.prepare('SELECT * FROM free_commends WHERE id = ?').get(req.params.id);
	if (!fc) return res.status(404).json({ error: 'Kayıt bulunamadı' });
	if (fc.transaction_id) {
		transitionTransactionStatus(fc.transaction_id, ['pending', 'processing', 'resuming'], 'cancelled', { refund: false });
	}
	db.prepare('DELETE FROM free_commends WHERE id = ?').run(fc.id);
	audit('free_commend_deleted', { targetId: fc.id, steamId: fc.steam_id }, req);
	res.json({ success: true });
});

router.get('/bots', (req, res) => {
	const manager = bm(req);
	if (!manager) return res.status(503).json({ error: 'Bot manager mevcut değil' });
	res.json({
		status: manager.status,
		bots: manager.getDetailedBotList(),
		busyAccounts: Array.from(manager._busyAccounts || []),
		connectedPlayers: manager._connectedPlayers ? manager._connectedPlayers.size : null,
		logListenerReady: !!manager._logListenerReady
	});
});

router.post('/bots/:username/start', async (req, res) => {
	const manager = bm(req);
	if (!manager) return res.status(503).json({ error: 'Bot manager mevcut değil' });
	const result = await manager.startBot(req.params.username);
	audit('bot_started', { username: req.params.username }, req);
	res.json(result);
});

router.post('/bots/:username/stop', async (req, res) => {
	const manager = bm(req);
	if (!manager) return res.status(503).json({ error: 'Bot manager mevcut değil' });
	const result = await manager.stopBot(req.params.username);
	audit('bot_stopped', { username: req.params.username }, req);
	res.json(result);
});

router.post('/bots/:username/reconnect', async (req, res) => {
	const manager = bm(req);
	if (!manager) return res.status(503).json({ error: 'Bot manager mevcut değil' });
	const result = await manager.reconnectBot(req.params.username);
	audit('bot_reconnected', { username: req.params.username }, req);
	res.json(result);
});

router.delete('/bots/:username', (req, res) => {
	const manager = bm(req);
	if (!manager) return res.status(503).json({ error: 'Bot manager mevcut değil' });
	let result;
	if (typeof manager._purgeInvalidAccount === 'function') {
		manager._purgeInvalidAccount(req.params.username, 'admin_purged');
		result = { success: true, purged: true };
	} else {
		result = manager.removeAccount(req.params.username);
	}
	audit('bot_purged', { username: req.params.username }, req);
	res.json(result);
});

router.post('/bots/bulk/reconnect', async (req, res) => {
	const manager = bm(req);
	if (!manager) return res.status(503).json({ error: 'Bot manager mevcut değil' });
	const results = await manager.reconnectAllFailed();
	audit('bots_reconnect_all', { count: results.length }, req);
	res.json({ results, reconnected: results.filter(r => r.success).length });
});

router.post('/bots/bulk/start', (req, res) => {
	const manager = bm(req);
	if (!manager) return res.status(503).json({ error: 'Bot manager mevcut değil' });
	manager.connectAllBots();
	audit('bots_start_all', {}, req);
	res.json({ success: true });
});

router.post('/bots/bulk/stop', async (req, res) => {
	const manager = bm(req);
	if (!manager) return res.status(503).json({ error: 'Bot manager mevcut değil' });
	await manager.stopAll();
	audit('bots_stop_all', {}, req);
	res.json({ success: true });
});

router.post('/bots/bulk/health-check', async (req, res) => {
	const manager = bm(req);
	if (!manager) return res.status(503).json({ error: 'Bot manager mevcut değil' });
	const bots = await manager.runHealthCheck();
	audit('bots_health_check', {}, req);
	res.json({ bots });
});

router.post('/bots', (req, res) => {
	const manager = bm(req);
	if (!manager) return res.status(503).json({ error: 'Bot manager mevcut değil' });
	const { username, password, sharedSecret } = req.body;
	if (!username || !password) return res.status(400).json({ error: 'username ve password gerekli' });
	const result = manager.addAccount({ username, password, sharedSecret: sharedSecret || '' });
	audit('bot_added', { username }, req);
	res.json(result);
});

router.get('/bots/invalid', (req, res) => {
	try {
		const file = path.join(__dirname, '..', '..', 'accounts.invalid.json');
		if (!fs.existsSync(file)) return res.json({ invalid: [] });
		const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
		const arr = Array.isArray(raw) ? raw : (raw.accounts || []);
		res.json({ invalid: arr });
	} catch (err) {
		console.error('[admin/bots/invalid]', err);
		res.status(500).json({ error: 'accounts.invalid.json okunamadı' });
	}
});

router.get('/proxies', (req, res) => {
	const manager = bm(req);
	if (!manager) return res.status(503).json({ error: 'Bot manager mevcut değil' });
	res.json({
		proxies: manager.getProxies(),
		mode: manager._proxyMode,
		switchEvery: manager._proxySwitchEvery
	});
});

router.post('/proxies', (req, res) => {
	const manager = bm(req);
	if (!manager) return res.status(503).json({ error: 'Bot manager mevcut değil' });
	const { proxy, proxies } = req.body;
	if (proxies && Array.isArray(proxies)) {
		const count = manager.loadProxies(proxies);
		audit('proxies_loaded', { count }, req);
		return res.json({ success: true, total: count });
	}
	if (proxy) {
		const count = manager.addProxy(proxy);
		audit('proxy_added', { proxy }, req);
		return res.json({ success: true, total: count });
	}
	res.status(400).json({ error: 'proxy veya proxies[] gerekli' });
});

router.delete('/proxies/:index', (req, res) => {
	const manager = bm(req);
	if (!manager) return res.status(503).json({ error: 'Bot manager mevcut değil' });
	const count = manager.removeProxy(parseInt(req.params.index));
	audit('proxy_removed', { index: req.params.index }, req);
	res.json({ success: true, total: count });
});

router.patch('/proxies/settings', (req, res) => {
	const manager = bm(req);
	if (!manager) return res.status(503).json({ error: 'Bot manager mevcut değil' });
	const { mode, switchEvery } = req.body;
	if (mode) manager._proxyMode = mode;
	if (switchEvery) manager._proxySwitchEvery = parseInt(switchEvery);
	manager._saveProxies && manager._saveProxies();
	audit('proxy_settings_changed', { mode, switchEvery }, req);
	res.json({ success: true, mode: manager._proxyMode, switchEvery: manager._proxySwitchEvery });
});

router.get('/server', (req, res) => {
	const manager = bm(req);
	if (!manager) return res.status(503).json({ error: 'Bot manager mevcut değil' });
	res.json({
		ip: manager._serverIP,
		port: manager._serverPort,
		rconIp: manager._rconIp,
		logReceiverIp: manager._logReceiverIp,
		logReceiverPort: manager._logReceiverPort,
		logListenerReady: !!manager._logListenerReady,
		connectedPlayers: manager._connectedPlayers ? Array.from(manager._connectedPlayers) : []
	});
});

router.patch('/server', (req, res) => {
	const manager = bm(req);
	if (!manager) return res.status(503).json({ error: 'Bot manager mevcut değil' });
	const { ip, port, password, rconIp } = req.body;
	if (!ip) return res.status(400).json({ error: 'IP gerekli' });
	manager.updateServer(ip, port, password, rconIp);
	try {
		const configPath = path.join(__dirname, '..', '..', 'config.json');
		const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
		config.server = config.server || {};
		config.server.ip = ip;
		if (port) config.server.port = port;
		if (password) config.server.password = password;
		if (rconIp !== undefined) config.server.rconIp = rconIp || ip;
		fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
	} catch {}
	audit('server_updated', { ip, port, rconIp }, req);
	res.json({ success: true });
});

router.post('/server/rcon-test', async (req, res) => {
	const manager = bm(req);
	if (!manager) return res.status(503).json({ error: 'Bot manager mevcut değil' });
	const result = await manager.testRcon();
	res.json(result);
});

router.get('/server/player-check/:steamid', async (req, res) => {
	const manager = bm(req);
	if (!manager) return res.status(503).json({ error: 'Bot manager mevcut değil' });
	try {
		const SteamID = require('steamid');
		const sid = new SteamID(req.params.steamid);
		if (!sid.isValid()) return res.status(400).json({ error: 'Geçersiz steamid' });
		const onServer = await manager.checkPlayerOnServer(sid.accountid);
		res.json({ steamid: sid.getSteamID64(), accountId: sid.accountid, onServer });
	} catch (err) {
		console.error('[admin/server/player-check]', err);
		res.status(400).json({ error: 'Oyuncu kontrol edilemedi' });
	}
});

router.get('/commend-count/:steamid', async (req, res) => {
	const manager = bm(req);
	if (!manager) return res.status(503).json({ error: 'Bot manager mevcut değil' });
	if (typeof manager.getPlayerCommendCount !== 'function') {
		return res.status(503).json({ error: 'getPlayerCommendCount mevcut değil' });
	}
	try {
		const SteamID = require('steamid');
		const sid = new SteamID(req.params.steamid);
		if (!sid.isValid()) return res.status(400).json({ error: 'Geçersiz steamid' });
		const counts = await manager.getPlayerCommendCount(sid.accountid);
		if (!counts) return res.status(503).json({ error: 'GC yanıt vermedi' });
		res.json({ steamid: sid.getSteamID64(), accountId: sid.accountid, ...counts });
	} catch (err) {
		console.error('[admin/commend-count]', err);
		res.status(500).json({ error: 'Övgü sayısı alınamadı' });
	}
});

const RCON_ALLOWED_COMMANDS = new Set([
	'status', 'stats', 'meta', 'meta list', 'meta version', 'css_plugins',
	'meta gameinfo', 'cvarlist', 'version', 'sv_showtags',
	'css_who', 'css_auth_clear',
	'css_is_on_server', 'css_auth_end',
	'changelevel', 'map', 'restart', 'sv_cheats', 'kickid', 'kick',
	'say', 'sm_say', 'sm_msay', 'css_say'
]);
const RCON_ALLOWED_PREFIXES = ['css_is_on_server', 'css_auth_end', 'changelevel', 'map',
	'kickid', 'kick', 'say', 'sm_say', 'sm_msay', 'css_say'];

function _rconIsAllowed(cmd) {
	const first = cmd.trim().split(/\s+/)[0]?.toLowerCase();
	if (!first) return false;
	if (RCON_ALLOWED_COMMANDS.has(first)) return true;
	if (RCON_ALLOWED_COMMANDS.has(cmd.trim().toLowerCase())) return true;
	return RCON_ALLOWED_PREFIXES.some(p => first === p);
}

router.post('/server/rcon-exec', async (req, res) => {
	const manager = bm(req);
	if (!manager) return res.status(503).json({ error: 'Bot manager mevcut değil' });
	const { command } = req.body;
	if (!command || typeof command !== 'string') return res.status(400).json({ error: 'command gerekli' });
	if (command.length > 500) return res.status(400).json({ error: 'command çok uzun' });

	if (!_rconIsAllowed(command)) {
		audit('rcon_exec_denied', { command: command.slice(0, 100) }, req);
		return res.status(403).json({ error: 'Komut izin listesinde değil (RCON allow-list)', hint: 'İzinli komutlar: ' + Array.from(RCON_ALLOWED_COMMANDS).join(', ') });
	}

	try {
		const Rcon = require('../../helpers/Rcon');
		const rcon = new Rcon(manager._rconIp, parseInt(manager._serverPort), manager._rconPassword);
		await rcon.connect();
		let reply = '';
		try { reply = await rcon.execute(command); }
		finally { try { rcon.disconnect(); } catch {} }
		audit('rcon_exec', { command, replyLength: reply?.length || 0 }, req);
		res.json({ success: true, reply });
	} catch (err) {
		console.error('[admin/rcon-exec]', err);
		res.status(500).json({ error: 'RCON komutu çalıştırılamadı' });
	}
});

function generatePromoCode(prefix) {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	const bytes = crypto.randomBytes(8);
	let code = prefix ? prefix.toUpperCase() + '-' : 'PROMO-';
	for (let i = 0; i < 8; i++) { if (i === 4) code += '-'; code += chars[bytes[i] % chars.length]; }
	return code;
}

router.get('/promos', (req, res) => {
	const page = parseInt(req.query.page) || 1;
	const limit = Math.min(parseInt(req.query.limit) || 20, 100);
	const offset = (page - 1) * limit;
	const promos = db.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
	const total = db.prepare('SELECT COUNT(*) as c FROM promo_codes').get().c;
	res.json({
		promos: promos.map(p => ({
			id: p.id, code: p.code, balance: p.balance, maxUses: p.max_uses, currentUses: p.current_uses,
			communityName: p.community_name, expiresAt: p.expires_at, isActive: !!p.is_active, createdAt: p.created_at
		})),
		total, page, totalPages: Math.ceil(total / limit)
	});
});

router.post('/promos/generate', (req, res) => {
	let { count, balance, maxUses, communityName, expiresAt, prefix } = req.body;
	count = parseInt(count) || 1;
	balance = parseInt(balance);
	maxUses = parseInt(maxUses) || 1;
	if (count <= 0 || count > 100) return res.status(400).json({ error: 'Adet 1-100 arası olmalı' });
	if (!balance || balance <= 0) return res.status(400).json({ error: 'Bakiye 0\'dan büyük olmalı' });

	const codes = [];
	const insert = db.prepare(
		'INSERT INTO promo_codes (code, balance, max_uses, community_name, expires_at) VALUES (?, ?, ?, ?, ?)'
	);
	const run = db.transaction(() => {
		for (let i = 0; i < count; i++) {
			let code = generatePromoCode(prefix), tries = 0;
			while (tries < 5) {
				try { insert.run(code, balance, maxUses, communityName || null, expiresAt || null); codes.push({ code, balance, maxUses }); break; }
				catch { code = generatePromoCode(prefix); tries++; }
			}
		}
	});
	run();
	audit('promos_generated', { count: codes.length, balance, maxUses, communityName }, req);
	res.json({ codes, generated: codes.length });
});

router.patch('/promos/:id', (req, res) => {
	const promo = db.prepare('SELECT * FROM promo_codes WHERE id = ?').get(req.params.id);
	if (!promo) return res.status(404).json({ error: 'Kod bulunamadı' });
	const { isActive, maxUses, expiresAt } = req.body;
	if (typeof isActive === 'boolean') db.prepare('UPDATE promo_codes SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, promo.id);
	if (maxUses !== undefined) db.prepare('UPDATE promo_codes SET max_uses = ? WHERE id = ?').run(parseInt(maxUses), promo.id);
	if (expiresAt !== undefined) db.prepare('UPDATE promo_codes SET expires_at = ? WHERE id = ?').run(expiresAt || null, promo.id);
	audit('promo_updated', { targetId: promo.id, code: promo.code }, req);
	res.json({ success: true });
});

router.delete('/promos/:id', (req, res) => {
	const promo = db.prepare('SELECT * FROM promo_codes WHERE id = ?').get(req.params.id);
	if (!promo) return res.status(404).json({ error: 'Kod bulunamadı' });
	db.prepare('DELETE FROM promo_redemptions WHERE promo_id = ?').run(promo.id);
	db.prepare('DELETE FROM promo_codes WHERE id = ?').run(promo.id);
	audit('promo_deleted', { targetId: promo.id, code: promo.code }, req);
	res.json({ success: true });
});

router.get('/promos/:id/redemptions', (req, res) => {
	const redemptions = db.prepare(
		`SELECT r.*, u.steam_id, u.steam_name FROM promo_redemptions r
		 JOIN users u ON u.id = r.user_id WHERE r.promo_id = ? ORDER BY r.redeemed_at DESC`
	).all(req.params.id);
	res.json({ redemptions });
});

router.get('/settings', (req, res) => {
	res.json({
		webhookUrl: getSetting('webhookUrl', ''),
		maintenance: getSetting('maintenance', 'false') === 'true',
		nodeVersion: process.version,
		platform: process.platform
	});
});

// Values merged from .env live only in memory, so write just the changed field
// back to disk instead of serialising the whole merged config.
function writeWebConfigField(key, value) {
	const file = path.join(__dirname, '..', 'config.json');
	const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
	raw[key] = value;
	fs.writeFileSync(file, JSON.stringify(raw, null, 2));
}

router.post('/settings/password', (req, res) => {
	const { currentPassword, newPassword } = req.body;
	const config = require('../config.json');
	if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Her iki şifre gerekli' });
	if (!safeEqual(currentPassword, config.adminPassword)) return res.status(403).json({ error: 'Mevcut şifre yanlış' });
	if (newPassword.length < 8) return res.status(400).json({ error: 'Yeni şifre en az 8 karakter olmalı' });
	if (process.env.ADMIN_PASSWORD) return res.status(409).json({ error: 'Şifre .env (ADMIN_PASSWORD) üzerinden yönetiliyor' });
	config.adminPassword = newPassword;
	writeWebConfigField('adminPassword', newPassword);
	audit('password_changed', {}, req);
	res.json({ success: true });
});

router.post('/settings/jwt-secret', (req, res) => {
	const config = require('../config.json');
	const secret = req.body.secret || crypto.randomBytes(32).toString('hex');
	if (process.env.JWT_SECRET) return res.status(409).json({ error: 'JWT secret .env (JWT_SECRET) üzerinden yönetiliyor' });
	config.jwtSecret = secret;
	writeWebConfigField('jwtSecret', secret);
	audit('jwt_secret_changed', {}, req);
	res.json({ success: true });
});

router.post('/settings/webhook', (req, res) => {
	const { url } = req.body;
	setSetting('webhookUrl', url || '');
	audit('webhook_updated', { url }, req);
	res.json({ success: true });
});

router.get('/announcement', (req, res) => {
	try {
		const raw = getSetting('announcement', null);
		if (!raw) return res.json({ active: false, level: 'info', title: '', body: '' });
		const parsed = JSON.parse(raw);
		res.json(parsed);
	} catch (e) {
		res.json({ active: false, level: 'info', title: '', body: '' });
	}
});

router.put('/announcement', (req, res) => {
	const { active, level, title, body } = req.body || {};
	const payload = {
		active: !!active,
		level: ['info', 'warn', 'critical'].includes(level) ? level : 'info',
		title: typeof title === 'string' ? title.slice(0, 200) : '',
		body: typeof body === 'string' ? body.slice(0, 2000) : '',
		updatedAt: new Date().toISOString()
	};
	if (payload.active && !payload.title && !payload.body) {
		return res.status(400).json({ error: 'Aktif duyuru için title veya body gerekli' });
	}
	setSetting('announcement', JSON.stringify(payload));
	audit('announcement_updated', { active: payload.active, level: payload.level, title: payload.title }, req);
	res.json({ success: true, announcement: payload });
});

router.post('/settings/webhook/test', async (req, res) => {
	const webhookUrl = getSetting('webhookUrl', '');
	if (!webhookUrl) return res.status(400).json({ error: 'Webhook URL tanımlı değil' });
	try {
		const http = webhookUrl.startsWith('https://') ? require('https') : require('http');
		const payload = JSON.stringify({
			content: 'CS Commends — webhook test',
			embeds: [{ title: 'Test Bildirimi', description: 'Webhook çalışıyor.', color: 0x00ff00, timestamp: new Date().toISOString() }]
		});
		await new Promise((resolve, reject) => {
			const u = new URL(webhookUrl);
			const r = http.request({
				hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
			}, (resp) => { resp.on('data', () => {}); resp.on('end', resolve); });
			r.on('error', reject);
			r.setTimeout(10000, () => { r.destroy(); reject(new Error('Timeout')); });
			r.write(payload); r.end();
		});
		res.json({ success: true });
	} catch (err) {
		console.error('[admin/webhook-test]', err);
		res.status(500).json({ error: 'Webhook testi başarısız (ağ hatası)' });
	}
});

router.post('/settings/maintenance', (req, res) => {
	const { enabled } = req.body;
	setSetting('maintenance', enabled ? 'true' : 'false');
	audit('maintenance_toggled', { enabled: !!enabled }, req);
	res.json({ success: true, maintenance: !!enabled });
});

router.get('/settings/runtime', (req, res) => {
	const processor = tp(req);
	res.json({
		concurrency: processor?.concurrency || null,
		delayBetweenCommends: processor?.delayBetweenCommends || null,
		adaptiveDelay: processor?._adaptiveDelay || null,
		verifyCommends: processor?.verifyCommends || false,
		maxRetries: processor?.maxRetries || null
	});
});

router.patch('/settings/runtime', (req, res) => {
	const processor = tp(req);
	if (!processor) return res.status(503).json({ error: 'Processor mevcut değil' });
	const { concurrency, delayBetweenCommends, maxRetries, verifyCommends } = req.body;
	if (typeof concurrency === 'number' && concurrency >= 1 && concurrency <= 20) processor.concurrency = concurrency;
	if (typeof delayBetweenCommends === 'number' && delayBetweenCommends >= 0) processor.delayBetweenCommends = delayBetweenCommends;
	if (typeof maxRetries === 'number' && maxRetries >= 0) processor.maxRetries = maxRetries;
	if (typeof verifyCommends === 'boolean') processor.verifyCommends = verifyCommends;
	audit('runtime_settings_changed', { concurrency, delayBetweenCommends, maxRetries, verifyCommends }, req);
	res.json({
		success: true,
		current: {
			concurrency: processor.concurrency,
			delayBetweenCommends: processor.delayBetweenCommends,
			maxRetries: processor.maxRetries,
			verifyCommends: processor.verifyCommends
		}
	});
});

router.get('/audit', (req, res) => {
	const page = parseInt(req.query.page) || 1;
	const limit = Math.min(parseInt(req.query.limit) || 50, 200);
	const offset = (page - 1) * limit;
	const action = req.query.action || '';
	const source = req.query.source || 'db';

	if (source === 'memory') {
		let filtered = auditLog;
		if (action) filtered = auditLog.filter(e => e.action === action);
		const sorted = [...filtered].reverse();
		return res.json({
			entries: sorted.slice(offset, offset + limit),
			total: filtered.length, page, totalPages: Math.ceil(filtered.length / limit)
		});
	}

	let where = '1=1'; const params = [];
	if (action) { where += ' AND action = ?'; params.push(action); }
	const entries = db.prepare(
		`SELECT * FROM audit_log WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
	).all(...params, limit, offset);
	const total = db.prepare(`SELECT COUNT(*) as c FROM audit_log WHERE ${where}`).get(...params).c;
	res.json({ entries, total, page, totalPages: Math.ceil(total / limit) });
});

router.get('/event-log', (req, res) => {
	const page = parseInt(req.query.page) || 1;
	const limit = Math.min(parseInt(req.query.limit) || 50, 200);
	const offset = (page - 1) * limit;
	const type = req.query.type || '';
	let filtered = eventLog;
	if (type) filtered = eventLog.filter(e => e.type === type);
	const sorted = [...filtered].reverse();
	res.json({
		entries: sorted.slice(offset, offset + limit),
		total: filtered.length, page, totalPages: Math.ceil(filtered.length / limit)
	});
});

router.get('/security/blocked-ips', (req, res) => {
	const now = Date.now();
	const list = [];
	for (const [ip, info] of blockedIPs.entries()) {
		if (now < info.until) list.push({ ip, until: info.until, reason: info.reason });
	}
	res.json({ blocked: list });
});

router.delete('/security/blocked-ips/:ip', (req, res) => {
	blockedIPs.delete(req.params.ip);
	audit('ip_unblocked', { ip: req.params.ip }, req);
	res.json({ success: true });
});

const { hashPassword } = require('../lib/password');

function currentPeriod() {
	const d = new Date();
	return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

router.get('/resellers', (req, res) => {
	const page = Math.max(1, parseInt(req.query.page, 10) || 1);
	const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
	const offset = (page - 1) * limit;
	const search = (req.query.search || '').trim();
	const statusFilter = req.query.status;

	let where = '1=1';
	const params = [];
	if (search) { where += " AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\' OR contact LIKE ? ESCAPE '\\')"; const p = `%${likeEscape(search)}%`; params.push(p, p, p); }
	if (statusFilter && ['active', 'suspended'].includes(statusFilter)) { where += ' AND status = ?'; params.push(statusFilter); }

	const rows = db.prepare(`
		SELECT id, username, display_name, contact, status, tier,
		       limit_commend, limit_hours, limit_group,
		       usage_commend, usage_hours, usage_group, usage_period,
		       total_commend, total_hours, total_group, total_codes,
		       last_login, created_at
		FROM resellers
		WHERE ${where}
		ORDER BY id DESC LIMIT ? OFFSET ?
	`).all(...params, limit, offset);

	const total = db.prepare('SELECT COUNT(*) AS c FROM resellers WHERE ' + where).get(...params).c;
	res.json({ resellers: rows, total, page, limit, totalPages: Math.ceil(total / limit) || 1 });
});

router.post('/resellers', (req, res) => {
	try {
		const { username, password, displayName, contact, tier, limitCommend, limitHours, limitGroup, notes } = req.body || {};

		const u = String(username || '').trim().toLowerCase();
		if (!/^[a-z0-9_-]{3,32}$/.test(u)) return res.status(400).json({ error: 'invalid_username', hint: '3-32 karakter, küçük harf/rakam/_/-' });

		if (!password || typeof password !== 'string' || password.length < 6) return res.status(400).json({ error: 'weak_password', hint: 'En az 6 karakter.' });

		if (db.prepare('SELECT 1 FROM resellers WHERE username = ?').get(u)) {
			return res.status(409).json({ error: 'username_taken' });
		}

		const { salt, hash } = hashPassword(password);
		const normLim = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

		const result = db.prepare(`
			INSERT INTO resellers (
				username, password_hash, password_salt, display_name, contact,
				tier, notes, status,
				limit_commend, limit_hours, limit_group,
				usage_period
			) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
		`).run(u, hash, salt, displayName || null, contact || null, tier || 'standard', notes || null,
			normLim(limitCommend), normLim(limitHours), normLim(limitGroup), currentPeriod());

		audit('reseller_created', { targetId: result.lastInsertRowid, targetType: 'reseller', username: u }, req);
		res.json({ success: true, id: result.lastInsertRowid });
	} catch (err) {
		console.error('[admin] reseller create error:', err);
		res.status(500).json({ error: 'internal_error', message: 'Bayilik oluşturulamadı' });
	}
});

router.patch('/resellers/:id', (req, res) => {
	try {
		const id = parseInt(req.params.id, 10);
		if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
		const r = db.prepare('SELECT * FROM resellers WHERE id = ?').get(id);
		if (!r) return res.status(404).json({ error: 'reseller_not_found' });

		const fields = [];
		const params = [];

		const b = req.body || {};
		if (b.displayName !== undefined) { fields.push('display_name = ?'); params.push(b.displayName); }
		if (b.contact !== undefined) { fields.push('contact = ?'); params.push(b.contact); }
		if (b.tier !== undefined) { fields.push('tier = ?'); params.push(b.tier); }
		if (b.notes !== undefined) { fields.push('notes = ?'); params.push(b.notes); }
		if (b.status !== undefined && ['active', 'suspended'].includes(b.status)) { fields.push('status = ?'); params.push(b.status); }

		['limitCommend', 'limitHours', 'limitGroup'].forEach(k => {
			if (b[k] !== undefined) {
				const n = parseInt(b[k], 10);
				if (!Number.isFinite(n)) return;
				const col = k === 'limitCommend' ? 'limit_commend' : k === 'limitHours' ? 'limit_hours' : 'limit_group';
				fields.push(col + ' = ?'); params.push(n);
			}
		});

		if (fields.length === 0) return res.status(400).json({ error: 'no_changes' });

		params.push(id);
		db.prepare('UPDATE resellers SET ' + fields.join(', ') + ' WHERE id = ?').run(...params);
		audit('reseller_updated', { targetId: id, targetType: 'reseller', changes: b }, req);
		res.json({ success: true });
	} catch (err) {
		console.error('[admin] reseller update error:', err);
		res.status(500).json({ error: 'internal_error' });
	}
});

router.delete('/resellers/:id', (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
	const r = db.prepare('SELECT username FROM resellers WHERE id = ?').get(id);
	if (!r) return res.status(404).json({ error: 'reseller_not_found' });

	db.transaction(() => {
		db.prepare('DELETE FROM reseller_sessions WHERE reseller_id = ?').run(id);
		db.prepare('UPDATE codes SET reseller_id = NULL WHERE reseller_id = ?').run(id);
		db.prepare('DELETE FROM resellers WHERE id = ?').run(id);
	})();
	audit('reseller_deleted', { targetId: id, targetType: 'reseller', username: r.username }, req);
	res.json({ success: true });
});

router.post('/resellers/:id/reset-password', (req, res) => {
	const id = parseInt(req.params.id, 10);
	const { password } = req.body || {};
	if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
	if (!password || typeof password !== 'string' || password.length < 6) return res.status(400).json({ error: 'weak_password' });
	const r = db.prepare('SELECT id FROM resellers WHERE id = ?').get(id);
	if (!r) return res.status(404).json({ error: 'reseller_not_found' });

	const { salt, hash } = hashPassword(password);
	db.transaction(() => {
		db.prepare('UPDATE resellers SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, id);
		db.prepare('UPDATE reseller_sessions SET revoked = 1 WHERE reseller_id = ?').run(id);
	})();
	audit('reseller_password_reset', { targetId: id, targetType: 'reseller' }, req);
	res.json({ success: true });
});

router.post('/resellers/:id/reset-usage', (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
	const r = db.prepare('SELECT id FROM resellers WHERE id = ?').get(id);
	if (!r) return res.status(404).json({ error: 'reseller_not_found' });

	db.prepare(`
		UPDATE resellers
		SET usage_commend = 0, usage_hours = 0, usage_group = 0, usage_period = ?
		WHERE id = ?
	`).run(currentPeriod(), id);
	audit('reseller_usage_reset', { targetId: id, targetType: 'reseller' }, req);
	res.json({ success: true });
});

router.get('/resellers/:id/codes', (req, res) => {
	const id = parseInt(req.params.id, 10);
	const page = Math.max(1, parseInt(req.query.page, 10) || 1);
	const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
	const offset = (page - 1) * limit;

	const rows = db.prepare(`
		SELECT id, code, balance, initial_balance, is_used, product_type, created_at, expires_at
		FROM codes WHERE reseller_id = ?
		ORDER BY id DESC LIMIT ? OFFSET ?
	`).all(id, limit, offset);
	const total = db.prepare('SELECT COUNT(*) AS c FROM codes WHERE reseller_id = ?').get(id).c;
	res.json({ codes: rows, total, page, limit, totalPages: Math.ceil(total / limit) || 1 });
});

router.get('/resellers/:id/audit', (req, res) => {
	const id = parseInt(req.params.id, 10);
	const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
	const rows = db.prepare(`
		SELECT id, action, details, ip, created_at
		FROM reseller_audit
		WHERE reseller_id = ?
		ORDER BY id DESC LIMIT ?
	`).all(id, limit);
	res.json({ audit: rows });
});

router.get('/hours', (req, res) => {
	const page = parseInt(req.query.page) || 1;
	const limit = Math.min(parseInt(req.query.limit) || 50, 200);
	const offset = (page - 1) * limit;
	const status = req.query.status;

	let where = '1=1';
	const params = [];
	if (status && ['pending', 'running', 'completed', 'failed', 'cancelled'].includes(status)) {
		where += ' AND h.status = ?';
		params.push(status);
	}

	const rows = db.prepare(
		`SELECT h.id, h.user_id, h.steam_username, h.steam_persona, h.steam_id64, h.appid,
		        h.requested_hours, h.hours_done, h.status, h.last_error,
		        h.started_at, h.last_tick, h.completed_at, h.created_at,
		        u.steam_id as user_steam_id
		   FROM hours_boost_sessions h
		   LEFT JOIN users u ON u.id = h.user_id
		  WHERE ${where}
		  ORDER BY h.id DESC LIMIT ? OFFSET ?`
	).all(...params, limit, offset);

	const total = db.prepare(
		`SELECT COUNT(*) as c FROM hours_boost_sessions h WHERE ${where}`
	).get(...params).c;

	const stats = db.prepare(`
		SELECT
		  COUNT(*) as total,
		  SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as running,
		  SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
		  SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
		  SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
		  SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) as cancelled,
		  COALESCE(SUM(hours_done), 0) as hours_total
		FROM hours_boost_sessions
	`).get();

	res.json({ sessions: rows, total, page, limit, stats });
});

router.get('/group', (req, res) => {
	const page = parseInt(req.query.page) || 1;
	const limit = Math.min(parseInt(req.query.limit) || 50, 200);
	const offset = (page - 1) * limit;
	const status = req.query.status;

	let where = '1=1';
	const params = [];
	if (status && ['pending', 'processing', 'completed', 'failed', 'cancelled'].includes(status)) {
		where += ' AND g.status = ?';
		params.push(status);
	}

	const rows = db.prepare(
		`SELECT g.id, g.user_id, g.group_id64, g.group_vanity, g.group_name, g.group_avatar,
		        g.requested_count, g.joined_count, g.status, g.last_error,
		        g.started_at, g.completed_at, g.created_at,
		        u.steam_id as user_steam_id
		   FROM group_orders g
		   LEFT JOIN users u ON u.id = g.user_id
		  WHERE ${where}
		  ORDER BY g.id DESC LIMIT ? OFFSET ?`
	).all(...params, limit, offset);

	const total = db.prepare(
		`SELECT COUNT(*) as c FROM group_orders g WHERE ${where}`
	).get(...params).c;

	const stats = db.prepare(`
		SELECT
		  COUNT(*) as total,
		  SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) as processing,
		  SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
		  SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
		  SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
		  SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) as cancelled,
		  COALESCE(SUM(joined_count), 0) as joins_total
		FROM group_orders
	`).get();

	res.json({ orders: rows, total, page, limit, stats });
});

router.get('/reviews', (req, res) => {
	const status = req.query.status;
	const product = req.query.productType;
	const minRating = parseInt(req.query.minRating, 10);
	const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
	const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

	const where = ['1=1'];
	const params = [];
	if (status && ['pending', 'approved', 'rejected'].includes(status)) {
		where.push('status = ?');
		params.push(status);
	}
	if (product && ['commend', 'hours', 'group', 'free'].includes(product)) {
		where.push('product_type = ?');
		params.push(product);
	}
	if (Number.isFinite(minRating) && minRating >= 1 && minRating <= 5) {
		where.push('rating >= ?');
		params.push(minRating);
	}

	const rows = db.prepare(`
		SELECT id, transaction_id, free_commend_id, user_id, steam_id, display_name, avatar_url,
		       product_type, rating, comment, status, admin_note, is_featured,
		       moderated_at, ip, created_at
		FROM reviews
		WHERE ${where.join(' AND ')}
		ORDER BY (status = 'pending') DESC, created_at DESC
		LIMIT ? OFFSET ?
	`).all(...params, limit, offset);

	const total = db.prepare(
		`SELECT COUNT(*) as c FROM reviews WHERE ${where.join(' AND ')}`
	).get(...params).c;

	const stats = db.prepare(`
		SELECT
		  SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
		  SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
		  SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
		  COUNT(*) as total,
		  COALESCE(AVG(CASE WHEN status = 'approved' THEN CAST(rating AS REAL) END), 0) as avgApproved
		FROM reviews
	`).get();

	res.json({ reviews: rows, total, limit, offset, stats });
});

const REVIEW_BONUS_AMOUNT = 10;

router.post('/reviews/:id/approve', (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!id) return res.status(400).json({ error: 'invalid_id' });

	const review = db.prepare(
		`SELECT id, user_id, status, transaction_id, free_commend_id, hours_session_id, group_order_id
		 FROM reviews WHERE id = ?`
	).get(id);
	if (!review) return res.status(404).json({ error: 'review_not_found' });

	const alreadyCredited = db.prepare(`
		SELECT 1 FROM audit_log
		WHERE action = 'review_bonus_credited' AND target_id = ? LIMIT 1
	`).get(String(id));

	let bonusBlockedReason = null;
	let creditedAmount = 0;
	let userCodeId = null;

	if (review.user_id && !alreadyCredited) {
		const u = db.prepare('SELECT code_id FROM users WHERE id = ?').get(review.user_id);
		userCodeId = u ? u.code_id : null;

		if (!userCodeId) {
			bonusBlockedReason = 'no_code_id';
		} else {
			const codeAlready = db.prepare(`
				SELECT 1 FROM audit_log
				WHERE action = 'review_bonus_credited'
				  AND json_extract(details, '$.codeId') = ?
				LIMIT 1
			`).get(userCodeId);
			if (codeAlready) {
				bonusBlockedReason = 'code_already_bonused';
			}
		}
	}

	const txAtomic = db.transaction(() => {
		const upd = db.prepare(`
			UPDATE reviews
			SET status = 'approved', moderated_at = datetime('now'), admin_note = NULL
			WHERE id = ?
		`).run(id);

		if (review.user_id && !alreadyCredited && !bonusBlockedReason) {
			const updRes = db.prepare(
				'UPDATE users SET balance = balance + ? WHERE id = ?'
			).run(REVIEW_BONUS_AMOUNT, review.user_id);
			if (updRes.changes > 0) {
				creditedAmount = REVIEW_BONUS_AMOUNT;
				db.prepare(
					`INSERT INTO audit_log (action, actor, target_id, target_type, details, ip)
					 VALUES ('review_bonus_credited', 'admin', ?, 'review', ?, ?)`
				).run(String(id), JSON.stringify({
					userId: review.user_id,
					codeId: userCodeId,
					amount: REVIEW_BONUS_AMOUNT,
					reviewId: id
				}), req.ip || '');
			}
		}

		return { changes: upd.changes };
	});

	const result = txAtomic();
	audit('review_approve', {
		targetId: id, targetType: 'review',
		bonusGiven: creditedAmount,
		bonusBlocked: bonusBlockedReason
	}, req);
	res.json({
		ok: true,
		changes: result.changes,
		bonusCredited: creditedAmount,
		bonusBlocked: bonusBlockedReason,
		bonusUserId: review.user_id
	});
});

router.post('/reviews/:id/reject', (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!id) return res.status(400).json({ error: 'invalid_id' });
	const note = (req.body && req.body.note) ? String(req.body.note).slice(0, 500) : null;
	const r = db.prepare(`
		UPDATE reviews
		SET status = 'rejected', moderated_at = datetime('now'), admin_note = ?
		WHERE id = ?
	`).run(note, id);
	audit('review_reject', { targetId: id, targetType: 'review', note }, req);
	res.json({ ok: true, changes: r.changes });
});

router.post('/reviews/:id/feature', (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!id) return res.status(400).json({ error: 'invalid_id' });
	const featured = req.body && req.body.featured ? 1 : 0;
	db.prepare('UPDATE reviews SET is_featured = ? WHERE id = ?').run(featured, id);
	audit('review_feature', { targetId: id, targetType: 'review', featured }, req);
	res.json({ ok: true });
});

router.delete('/reviews/:id', (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!id) return res.status(400).json({ error: 'invalid_id' });
	const r = db.prepare('DELETE FROM reviews WHERE id = ?').run(id);
	audit('review_delete', { targetId: id, targetType: 'review' }, req);
	res.json({ ok: true, deleted: r.changes });
});

router.post('/reviews/bulk', (req, res) => {
	const { ids, action, note } = req.body || {};
	if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids_required' });
	if (!['approve', 'reject', 'delete'].includes(action)) return res.status(400).json({ error: 'invalid_action' });

	const cleanIds = ids.map(i => parseInt(i, 10)).filter(i => Number.isFinite(i));
	if (!cleanIds.length) return res.status(400).json({ error: 'no_valid_ids' });

	const placeholders = cleanIds.map(() => '?').join(',');
	let r;
	if (action === 'approve') {
		r = db.prepare(`UPDATE reviews SET status='approved', moderated_at=datetime('now'), admin_note=NULL WHERE id IN (${placeholders})`).run(...cleanIds);
	} else if (action === 'reject') {
		const n = note ? String(note).slice(0, 500) : null;
		r = db.prepare(`UPDATE reviews SET status='rejected', moderated_at=datetime('now'), admin_note=? WHERE id IN (${placeholders})`).run(n, ...cleanIds);
	} else {
		r = db.prepare(`DELETE FROM reviews WHERE id IN (${placeholders})`).run(...cleanIds);
	}
	audit('review_bulk_' + action, { targetType: 'review', ids: cleanIds, count: r.changes, note }, req);
	res.json({ ok: true, changes: r.changes });
});

router.get('/server-update/status', (req, res) => {
	const monitor = req.app.locals.serverUpdateMonitor;
	if (!monitor) return res.status(503).json({ error: 'monitor_not_running' });
	res.json({ ok: true, ...monitor.getStatus() });
});

router.post('/server-update/check-now', async (req, res) => {
	const monitor = req.app.locals.serverUpdateMonitor;
	if (!monitor) return res.status(503).json({ error: 'monitor_not_running' });
	audit('server_update_check_triggered', {}, req);
	monitor.forceCheck().catch(err => console.error('[admin] forceCheck err:', err.message));
	res.json({ ok: true, message: 'kontrol arka planda başladı — service.js logu / Discord webhook izleyin' });
});

const metrics = require('../lib/metrics');
router.get('/metrics', (req, res) => {
	const snap = metrics.getSnapshot();

	try {
		const dbm = require('../database');
		const txCounts = dbm.prepare(`
			SELECT status, COUNT(*) as c FROM transactions
			WHERE created_at > datetime('now', '-24 hours')
			GROUP BY status
		`).all();
		const cancelReasons24h = dbm.prepare(`
			SELECT COALESCE(error_message, error_type, 'unknown') as reason, COUNT(*) as c
			FROM transactions
			WHERE status IN ('failed','cancelled') AND completed_at > datetime('now', '-24 hours')
			GROUP BY reason
			ORDER BY c DESC
			LIMIT 10
		`).all();
		const refundedSum24h = dbm.prepare(`
			SELECT COALESCE(SUM(total - progress), 0) as s
			FROM transactions
			WHERE status IN ('failed','cancelled') AND completed_at > datetime('now', '-24 hours')
		`).get().s;

		snap.last24h = {
			transactionsByStatus: txCounts.reduce((acc, r) => { acc[r.status] = r.c; return acc; }, {}),
			topCancelReasons: cancelReasons24h,
			refundedTotal: refundedSum24h
		};
	} catch (e) {
		snap.last24hError = e.message;
	}

	const bm = req.app.locals.botManager;
	if (bm && typeof bm.getStatus === 'function') {
		try { snap.botPool = bm.getStatus(); } catch (e) { snap.botPoolError = e.message; }
	}

	res.json(snap);
});

router.get('/metrics/recent-requests', (req, res) => {
	const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
	res.json({ requests: metrics.getRecentRequests(limit) });
});

router.get('/pipeline', (req, res) => {
	const manager = bm(req);
	if (!manager || typeof manager.getPipelineConfig !== 'function') {
		return res.status(503).json({ error: 'BotManager not available' });
	}
	res.json(manager.getPipelineConfig());
});

router.patch('/pipeline', (req, res) => {
	const manager = bm(req);
	if (!manager || typeof manager.setPipelineConfig !== 'function') {
		return res.status(503).json({ error: 'BotManager not available' });
	}
	const updated = manager.setPipelineConfig(req.body || {});
	try {
		db.prepare(
			`INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))`
		).run(
			req.user && req.user.username ? `admin:${req.user.username}` : 'admin',
			'pipeline_config_update',
			'bot_manager',
			JSON.stringify(req.body || {})
		);
	} catch {}
	res.json({ ok: true, config: updated });
});

module.exports = router;
