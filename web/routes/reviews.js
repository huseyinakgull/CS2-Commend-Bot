const express = require('express');
const db = require('../database');
const { verifyUser, rateLimit } = require('../middleware/auth');

const router = express.Router();

function clampRating(v) {
	const n = parseInt(v, 10);
	if (!Number.isFinite(n)) return null;
	if (n < 1 || n > 5) return null;
	return n;
}

function cleanComment(s) {
	if (s == null) return null;
	const trimmed = String(s).trim();
	if (!trimmed) return null;
	return trimmed.slice(0, 500);
}

function ipOf(req) {
	return req.ip || req.socket.remoteAddress || null;
}

function uaOf(req) {
	return (req.headers['user-agent'] || '').slice(0, 200);
}

function publicShape(r) {
	const out = {
		id: r.id,
		rating: r.rating,
		comment: r.comment,
		productType: r.product_type,
		displayName: r.display_name || (r.steam_id ? 'CS2 Oyuncusu' : 'Anonim'),
		avatarUrl: r.avatar_url || null,
		verified: r.transaction_id != null,
		featured: !!r.is_featured,
		date: r.created_at,
		reviewerSteamId: r.steam_id || null,
		reviewerProfileUrl: r.steam_id ? `https://steamcommunity.com/profiles/${r.steam_id}` : null,
		orderId: null,
		orderLabel: null,
		amount: null,
		amountLabel: null,
		targetSteamId: null,
		targetProfileUrl: null,
		targetGroupName: null,
		targetGroupUrl: null
	};

	if (r.transaction_id) {
		const tx = db.prepare(
			'SELECT id, steam_id, total FROM transactions WHERE id = ?'
		).get(r.transaction_id);
		if (tx) {
			out.orderId = tx.id;
			out.orderLabel = '#' + tx.id;
			out.amount = tx.total;
			out.amountLabel = tx.total + ' commend';
			out.targetSteamId = tx.steam_id;
			out.targetProfileUrl = tx.steam_id ? `https://steamcommunity.com/profiles/${tx.steam_id}` : null;
		}
	} else if (r.free_commend_id) {
		const fc = db.prepare(
			'SELECT id, steam_id, total FROM free_commends WHERE id = ?'
		).get(r.free_commend_id);
		if (fc) {
			out.orderId = fc.id;
			out.orderLabel = 'Ücretsiz #' + fc.id;
			out.amount = fc.total;
			out.amountLabel = fc.total + ' ücretsiz commend';
			out.targetSteamId = fc.steam_id;
			out.targetProfileUrl = fc.steam_id ? `https://steamcommunity.com/profiles/${fc.steam_id}` : null;
		}
	} else if (r.hours_session_id) {
		const sess = db.prepare(
			'SELECT id, steam_id64, requested_hours FROM hours_boost_sessions WHERE id = ?'
		).get(r.hours_session_id);
		if (sess) {
			out.orderId = sess.id;
			out.orderLabel = '#' + sess.id;
			out.amount = sess.requested_hours;
			out.amountLabel = sess.requested_hours + ' saat';
			out.targetSteamId = sess.steam_id64;
			out.targetProfileUrl = sess.steam_id64 ? `https://steamcommunity.com/profiles/${sess.steam_id64}` : null;
		}
	} else if (r.group_order_id) {
		const order = db.prepare(
			'SELECT id, group_name, group_vanity, group_id64, requested_count FROM group_orders WHERE id = ?'
		).get(r.group_order_id);
		if (order) {
			out.orderId = order.id;
			out.orderLabel = '#' + order.id;
			out.amount = order.requested_count;
			out.amountLabel = order.requested_count + ' üye';
			out.targetGroupName = order.group_name || order.group_vanity || null;
			out.targetGroupUrl = order.group_vanity
				? `https://steamcommunity.com/groups/${order.group_vanity}`
				: (order.group_id64 ? `https://steamcommunity.com/gid/${order.group_id64}` : null);
		}
	}

	return out;
}

const REVIEWS_RATE = rateLimit(120, 60_000, 'reviews-read');

router.get('/public', REVIEWS_RATE, (req, res) => {
	const limit = Math.min(parseInt(req.query.limit, 10) || 12, 50);
	const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
	const product = req.query.product;
	const minRating = Math.max(parseInt(req.query.minRating, 10) || 1, 1);

	const where = ["status = 'approved'", 'rating >= ?'];
	const params = [minRating];
	if (product && ['commend', 'hours', 'group', 'free'].includes(product)) {
		where.push('product_type = ?');
		params.push(product);
	}
	const sql = `
		SELECT id, transaction_id, free_commend_id, hours_session_id, group_order_id,
		       steam_id, display_name, avatar_url,
		       product_type, rating, comment, is_featured, created_at
		FROM reviews
		WHERE ${where.join(' AND ')}
		ORDER BY is_featured DESC, created_at DESC
		LIMIT ? OFFSET ?
	`;
	params.push(limit, offset);

	const rows = db.prepare(sql).all(...params).map(publicShape);
	const total = db.prepare(`SELECT COUNT(*) as c FROM reviews WHERE ${where.join(' AND ')}`)
		.get(...params.slice(0, -2)).c;

	res.json({ reviews: rows, total, limit, offset });
});

router.get('/aggregate', REVIEWS_RATE, (req, res) => {
	const stat = db.prepare(`
		SELECT COUNT(*) as count,
		       COALESCE(AVG(CAST(rating AS REAL)), 0) as average,
		       SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) as r5,
		       SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) as r4,
		       SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) as r3,
		       SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) as r2,
		       SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as r1
		FROM reviews WHERE status = 'approved'
	`).get();

	res.json({
		count: stat.count || 0,
		average: stat.count ? Number(stat.average.toFixed(2)) : 0,
		distribution: { 5: stat.r5, 4: stat.r4, 3: stat.r3, 2: stat.r2, 1: stat.r1 }
	});
});

router.get('/my', verifyUser, (req, res) => {
	const rows = db.prepare(`
		SELECT id, transaction_id, free_commend_id, product_type, rating, comment,
		       status, admin_note, created_at, moderated_at
		FROM reviews
		WHERE user_id = ?
		ORDER BY created_at DESC LIMIT 100
	`).all(req.user.userId);
	res.json({ reviews: rows });
});

router.get('/my-pending', verifyUser, (req, res) => {
	const userId = req.user.userId;

	const txCount = db.prepare(`
		SELECT COUNT(*) as c FROM transactions t
		WHERE t.user_id = ? AND t.status IN ('completed', 'partial')
		  AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.transaction_id = t.id)
	`).get(userId).c;
	const hoursCount = db.prepare(`
		SELECT COUNT(*) as c FROM hours_boost_sessions h
		WHERE h.user_id = ? AND h.status = 'completed'
		  AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.hours_session_id = h.id)
	`).get(userId).c;
	const groupCount = db.prepare(`
		SELECT COUNT(*) as c FROM group_orders g
		WHERE g.user_id = ? AND g.status = 'completed'
		  AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.group_order_id = g.id)
	`).get(userId).c;

	const recent = db.prepare(`
		SELECT * FROM (
			SELECT t.id as id, 'commend' as kind, t.total as units, t.completed_at as completed_at
			FROM transactions t
			WHERE t.user_id = ? AND t.status IN ('completed','partial')
			  AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.transaction_id = t.id)
			UNION ALL
			SELECT h.id as id, 'hours' as kind, h.requested_hours as units, h.completed_at as completed_at
			FROM hours_boost_sessions h
			WHERE h.user_id = ? AND h.status = 'completed'
			  AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.hours_session_id = h.id)
			UNION ALL
			SELECT g.id as id, 'group' as kind, g.requested_count as units, g.completed_at as completed_at
			FROM group_orders g
			WHERE g.user_id = ? AND g.status = 'completed'
			  AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.group_order_id = g.id)
		)
		ORDER BY completed_at DESC LIMIT 5
	`).all(userId, userId, userId);

	res.json({
		count: txCount + hoursCount + groupCount,
		breakdown: { commend: txCount, hours: hoursCount, group: groupCount },
		recent
	});
});

function userMatch(rowUserId, jwtUserId) {
	return Number(rowUserId) === Number(jwtUserId);
}

function userBonusAvailable(userId) {
	if (!userId) return false;
	const u = db.prepare('SELECT code_id FROM users WHERE id = ?').get(userId);
	if (!u || !u.code_id) return false;
	const already = db.prepare(`
		SELECT 1 FROM audit_log
		WHERE action = 'review_bonus_credited'
		  AND json_extract(details, '$.codeId') = ?
		LIMIT 1
	`).get(u.code_id);
	return !already;
}

router.get('/bonus-status', verifyUser, (req, res) => {
	res.json({ ok: true, bonusAvailable: userBonusAvailable(req.user.userId), bonusAmount: 10 });
});

router.get('/eligible/tx/:id', verifyUser, (req, res) => {
	const txId = parseInt(req.params.id, 10);
	if (!txId) return res.status(400).json({ ok: false, error: 'invalid_id' });

	const tx = db.prepare(
		`SELECT id, user_id, status FROM transactions WHERE id = ?`
	).get(txId);

	if (!tx) return res.json({ ok: true, eligible: false, reason: 'not_found' });
	if (!userMatch(tx.user_id, req.user.userId)) {
		return res.json({ ok: true, eligible: false, reason: 'not_yours' });
	}
	if (!['completed', 'partial'].includes(tx.status)) {
		return res.json({ ok: true, eligible: false, reason: 'not_completed', currentStatus: tx.status });
	}

	const existing = db.prepare('SELECT id, status FROM reviews WHERE transaction_id = ?').get(txId);
	if (existing) {
		return res.json({ ok: true, eligible: false, reason: 'already_reviewed', existingStatus: existing.status });
	}

	res.json({ ok: true, eligible: true, productType: 'commend', bonusAvailable: userBonusAvailable(req.user.userId), bonusAmount: 10 });
});

router.get('/eligible/hours/:id', verifyUser, (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!id) return res.status(400).json({ ok: false, error: 'invalid_id' });

	const sess = db.prepare(
		`SELECT id, user_id, status FROM hours_boost_sessions WHERE id = ?`
	).get(id);

	if (!sess) return res.json({ ok: true, eligible: false, reason: 'not_found' });
	if (!userMatch(sess.user_id, req.user.userId)) {
		return res.json({ ok: true, eligible: false, reason: 'not_yours' });
	}
	if (sess.status !== 'completed') {
		return res.json({ ok: true, eligible: false, reason: 'not_completed', currentStatus: sess.status });
	}

	const existing = db.prepare('SELECT id, status FROM reviews WHERE hours_session_id = ?').get(id);
	if (existing) {
		return res.json({ ok: true, eligible: false, reason: 'already_reviewed', existingStatus: existing.status });
	}

	res.json({ ok: true, eligible: true, productType: 'hours', bonusAvailable: userBonusAvailable(req.user.userId), bonusAmount: 10 });
});

router.get('/eligible/group/:id', verifyUser, (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!id) return res.status(400).json({ ok: false, error: 'invalid_id' });

	const order = db.prepare(
		`SELECT id, user_id, status FROM group_orders WHERE id = ?`
	).get(id);

	if (!order) return res.json({ ok: true, eligible: false, reason: 'not_found' });
	if (!userMatch(order.user_id, req.user.userId)) {
		return res.json({ ok: true, eligible: false, reason: 'not_yours' });
	}
	if (order.status !== 'completed') {
		return res.json({ ok: true, eligible: false, reason: 'not_completed', currentStatus: order.status });
	}

	const existing = db.prepare('SELECT id, status FROM reviews WHERE group_order_id = ?').get(id);
	if (existing) {
		return res.json({ ok: true, eligible: false, reason: 'already_reviewed', existingStatus: existing.status });
	}

	res.json({ ok: true, eligible: true, productType: 'group', bonusAvailable: userBonusAvailable(req.user.userId), bonusAmount: 10 });
});

const REVIEWS_SUBMIT_RATE = rateLimit(5, 3600_000, 'reviews-submit');

router.post('/', verifyUser, REVIEWS_SUBMIT_RATE, (req, res) => {
	const { transactionId, rating: rRaw, comment: cRaw } = req.body || {};
	const txId = parseInt(transactionId, 10);
	const rating = clampRating(rRaw);
	const comment = cleanComment(cRaw);

	if (!txId) return res.status(400).json({ ok: false, error: 'transactionId_required' });
	if (rating == null) return res.status(400).json({ ok: false, error: 'rating_must_be_1_to_5' });

	const tx = db.prepare(
		`SELECT id, user_id, status FROM transactions WHERE id = ?`
	).get(txId);

	if (!tx) return res.status(404).json({ ok: false, error: 'transaction_not_found' });
	if (!userMatch(tx.user_id, req.user.userId)) return res.status(403).json({ ok: false, error: 'not_yours' });
	if (!['completed', 'partial'].includes(tx.status)) {
		return res.status(400).json({ ok: false, error: 'transaction_not_completed' });
	}

	const dup = db.prepare('SELECT id FROM reviews WHERE transaction_id = ?').get(txId);
	if (dup) return res.status(409).json({ ok: false, error: 'already_reviewed' });

	const user = db.prepare('SELECT steam_id, steam_name FROM users WHERE id = ?').get(req.user.userId);

	try {
		const r = db.prepare(`
			INSERT INTO reviews
				(transaction_id, user_id, steam_id, display_name, product_type, rating, comment, status, ip, user_agent)
			VALUES (?, ?, ?, ?, 'commend', ?, ?, 'pending', ?, ?)
		`).run(txId, req.user.userId, user?.steam_id || null, user?.steam_name || null,
			   rating, comment, ipOf(req), uaOf(req));

		res.json({ ok: true, id: r.lastInsertRowid, status: 'pending', message: 'Yorumunuz moderasyon sonrası yayınlanacak.' });
	} catch (err) {
		if (/UNIQUE/.test(err.message)) return res.status(409).json({ ok: false, error: 'already_reviewed' });
		console.error('[reviews/commend]', err);
		res.status(500).json({ ok: false, error: 'Yorum kaydedilemedi' });
	}
});

router.post('/hours', verifyUser, REVIEWS_SUBMIT_RATE, (req, res) => {
	const { sessionId, rating: rRaw, comment: cRaw } = req.body || {};
	const id = parseInt(sessionId, 10);
	const rating = clampRating(rRaw);
	const comment = cleanComment(cRaw);

	if (!id) return res.status(400).json({ ok: false, error: 'sessionId_required' });
	if (rating == null) return res.status(400).json({ ok: false, error: 'rating_must_be_1_to_5' });

	const sess = db.prepare(
		`SELECT id, user_id, status, steam_id64 FROM hours_boost_sessions WHERE id = ?`
	).get(id);

	if (!sess) return res.status(404).json({ ok: false, error: 'session_not_found' });
	if (!userMatch(sess.user_id, req.user.userId)) return res.status(403).json({ ok: false, error: 'not_yours' });
	if (sess.status !== 'completed') return res.status(400).json({ ok: false, error: 'session_not_completed' });

	const dup = db.prepare('SELECT id FROM reviews WHERE hours_session_id = ?').get(id);
	if (dup) return res.status(409).json({ ok: false, error: 'already_reviewed' });

	const user = db.prepare('SELECT steam_id, steam_name FROM users WHERE id = ?').get(req.user.userId);

	try {
		const r = db.prepare(`
			INSERT INTO reviews
				(hours_session_id, user_id, steam_id, display_name, product_type, rating, comment, status, ip, user_agent)
			VALUES (?, ?, ?, ?, 'hours', ?, ?, 'pending', ?, ?)
		`).run(id, req.user.userId,
			   sess.steam_id64 || user?.steam_id || 'unknown',
			   user?.steam_name || null,
			   rating, comment, ipOf(req), uaOf(req));

		res.json({ ok: true, id: r.lastInsertRowid, status: 'pending', message: 'Yorumunuz moderasyon sonrası yayınlanacak.' });
	} catch (err) {
		if (/UNIQUE/.test(err.message)) return res.status(409).json({ ok: false, error: 'already_reviewed' });
		console.error('[reviews/hours]', err);
		res.status(500).json({ ok: false, error: 'Yorum kaydedilemedi' });
	}
});

router.post('/group', verifyUser, REVIEWS_SUBMIT_RATE, (req, res) => {
	const { orderId, rating: rRaw, comment: cRaw } = req.body || {};
	const id = parseInt(orderId, 10);
	const rating = clampRating(rRaw);
	const comment = cleanComment(cRaw);

	if (!id) return res.status(400).json({ ok: false, error: 'orderId_required' });
	if (rating == null) return res.status(400).json({ ok: false, error: 'rating_must_be_1_to_5' });

	const order = db.prepare(
		`SELECT id, user_id, status FROM group_orders WHERE id = ?`
	).get(id);

	if (!order) return res.status(404).json({ ok: false, error: 'order_not_found' });
	if (!userMatch(order.user_id, req.user.userId)) return res.status(403).json({ ok: false, error: 'not_yours' });
	if (order.status !== 'completed') return res.status(400).json({ ok: false, error: 'order_not_completed' });

	const dup = db.prepare('SELECT id FROM reviews WHERE group_order_id = ?').get(id);
	if (dup) return res.status(409).json({ ok: false, error: 'already_reviewed' });

	const user = db.prepare('SELECT steam_id, steam_name FROM users WHERE id = ?').get(req.user.userId);

	try {
		const r = db.prepare(`
			INSERT INTO reviews
				(group_order_id, user_id, steam_id, display_name, product_type, rating, comment, status, ip, user_agent)
			VALUES (?, ?, ?, ?, 'group', ?, ?, 'pending', ?, ?)
		`).run(id, req.user.userId,
			   user?.steam_id || 'unknown',
			   user?.steam_name || null,
			   rating, comment, ipOf(req), uaOf(req));

		res.json({ ok: true, id: r.lastInsertRowid, status: 'pending', message: 'Yorumunuz moderasyon sonrası yayınlanacak.' });
	} catch (err) {
		if (/UNIQUE/.test(err.message)) return res.status(409).json({ ok: false, error: 'already_reviewed' });
		console.error('[reviews/group]', err);
		res.status(500).json({ ok: false, error: 'Yorum kaydedilemedi' });
	}
});

router.post('/free', REVIEWS_SUBMIT_RATE, (req, res) => {
	const { freeCommendId, steamId, rating: rRaw, comment: cRaw } = req.body || {};
	const fcId = parseInt(freeCommendId, 10);
	const rating = clampRating(rRaw);
	const comment = cleanComment(cRaw);

	if (!fcId) return res.status(400).json({ ok: false, error: 'freeCommendId_required' });
	if (!steamId) return res.status(400).json({ ok: false, error: 'steamId_required' });
	if (rating == null) return res.status(400).json({ ok: false, error: 'rating_must_be_1_to_5' });

	const fc = db.prepare(
		`SELECT id, steam_id, status FROM free_commends WHERE id = ?`
	).get(fcId);

	if (!fc) return res.status(404).json({ ok: false, error: 'free_commend_not_found' });
	if (String(fc.steam_id) !== String(steamId)) {
		return res.status(403).json({ ok: false, error: 'steam_id_mismatch' });
	}
	if (fc.status !== 'completed') {
		return res.status(400).json({ ok: false, error: 'free_commend_not_completed' });
	}

	const dup = db.prepare('SELECT id FROM reviews WHERE free_commend_id = ?').get(fcId);
	if (dup) return res.status(409).json({ ok: false, error: 'already_reviewed' });

	try {
		const r = db.prepare(`
			INSERT INTO reviews
				(free_commend_id, steam_id, product_type, rating, comment, status, ip, user_agent)
			VALUES (?, ?, 'free', ?, ?, 'pending', ?, ?)
		`).run(fcId, steamId, rating, comment, ipOf(req), uaOf(req));

		res.json({ ok: true, id: r.lastInsertRowid, status: 'pending', message: 'Yorumunuz moderasyon sonrası yayınlanacak.' });
	} catch (err) {
		if (/UNIQUE/.test(err.message)) return res.status(409).json({ ok: false, error: 'already_reviewed' });
		console.error('[reviews/free]', err);
		res.status(500).json({ ok: false, error: 'Yorum kaydedilemedi' });
	}
});

module.exports = router;
