const express = require('express');
const db = require('../database');
const { verifyUser, rateLimit } = require('../middleware/auth');
const { blockIfMaintenance } = require('../middleware/maintenance');
const { resolveGroup } = require('../lib/steam-ids');

const router = express.Router();

const MIN_MEMBERS = 10;
const MAX_MEMBERS = 2000;

function requireGroupProduct(req, res, next) {
	const pt = (req.user && req.user.productType) || 'commend';
	if (pt !== 'group') {
		return res.status(403).json({ error: 'wrong_product_type', required: 'group', current: pt });
	}
	next();
}

router.post('/resolve', verifyUser, rateLimit(10, 60000, 'group-resolve'), async (req, res) => {
	try {
		const { groupInput } = req.body || {};
		if (!groupInput || typeof groupInput !== 'string') {
			return res.status(400).json({ error: 'invalid_input' });
		}
		const meta = await resolveGroup(groupInput);
		if (!meta) return res.status(404).json({ error: 'group_not_found' });
		res.json({
			id64: meta.id64,
			name: meta.name,
			vanity: meta.vanity,
			avatar: meta.avatar,
			memberCount: meta.memberCount
		});
	} catch (err) {
		console.error('[group] resolve error:', err);
		res.status(500).json({ error: 'internal_error' });
	}
});

router.post('/order',
	verifyUser,
	blockIfMaintenance,
	requireGroupProduct,
	rateLimit(5, 60000, 'group-order'),
	async (req, res) => {
		try {
			const { groupInput, count } = req.body || {};
			if (!groupInput) return res.status(400).json({ error: 'invalid_input' });

			const requested = parseInt(count, 10);
			if (!Number.isFinite(requested) || requested < MIN_MEMBERS || requested > MAX_MEMBERS) {
				return res.status(400).json({ error: 'invalid_count', min: MIN_MEMBERS, max: MAX_MEMBERS });
			}

			const meta = await resolveGroup(groupInput);
			if (!meta) return res.status(404).json({ error: 'group_not_found' });

			const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId);
			if (!user) return res.status(404).json({ error: 'user_not_found' });
			if (user.banned) return res.status(403).json({ error: 'account_banned' });
			if ((user.product_type || 'commend') !== 'group') {
				return res.status(403).json({ error: 'wrong_product_type' });
			}
			if (user.balance < requested) {
				return res.status(400).json({ error: 'insufficient_balance', required: requested, have: user.balance });
			}

			const created = db.transaction(() => {
				const deduct = db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?')
					.run(requested, user.id, requested);
				if (deduct.changes === 0) throw new Error('balance_deduct_race');

				const ins = db.prepare(`
					INSERT INTO group_orders
					  (user_id, group_id64, group_vanity, group_name, group_avatar, requested_count)
					VALUES (?, ?, ?, ?, ?, ?)
				`).run(user.id, meta.id64, meta.vanity || null, meta.name || null, meta.avatar || null, requested);
				return db.prepare('SELECT * FROM group_orders WHERE id = ?').get(ins.lastInsertRowid);
			})();

			res.json({
				success: true,
				order: {
					id: created.id,
					groupId: created.group_id64,
					groupName: created.group_name,
					groupVanity: created.group_vanity,
					groupAvatar: created.group_avatar,
					requestedCount: created.requested_count,
					joinedCount: 0,
					status: created.status
				}
			});
		} catch (err) {
			console.error('[group] order error:', err);
			res.status(500).json({ error: 'internal_error', message: 'Grup siparişi oluşturulamadı' });
		}
	}
);

router.get('/list', verifyUser, requireGroupProduct, (req, res) => {
	const manager = req.app.locals.groupManager;
	const rows = manager
		? manager.listUserOrders(req.user.userId)
		: db.prepare(`
			SELECT id, group_id64, group_vanity, group_name, group_avatar,
			       requested_count, joined_count, status, last_error,
			       started_at, completed_at, created_at
			FROM group_orders WHERE user_id = ? ORDER BY id DESC
		`).all(req.user.userId);
	res.json({ orders: rows });
});

router.get('/status/:id', verifyUser, requireGroupProduct, (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
	const row = db.prepare('SELECT * FROM group_orders WHERE id = ? AND user_id = ?').get(id, req.user.userId);
	if (!row) return res.status(404).json({ error: 'order_not_found' });
	res.json({
		id: row.id,
		groupId: row.group_id64,
		groupVanity: row.group_vanity,
		groupName: row.group_name,
		groupAvatar: row.group_avatar,
		requestedCount: row.requested_count,
		joinedCount: row.joined_count,
		status: row.status,
		lastError: row.last_error,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		createdAt: row.created_at
	});
});

router.post('/cancel/:id', verifyUser, requireGroupProduct, (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
	const row = db.prepare('SELECT * FROM group_orders WHERE id = ? AND user_id = ?').get(id, req.user.userId);
	if (!row) return res.status(404).json({ error: 'order_not_found' });
	if (row.status !== 'pending' && row.status !== 'processing') {
		return res.status(400).json({ error: 'not_cancellable', status: row.status });
	}

	const remaining = Math.max(0, row.requested_count - row.joined_count);
	const cancelled = db.transaction(() => {
		const upd = db.prepare(`
			UPDATE group_orders SET status = 'cancelled', completed_at = datetime('now')
			WHERE id = ? AND status IN ('pending', 'processing')
		`).run(id);
		if (upd.changes === 0) return 0;
		if (remaining > 0) {
			db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(remaining, req.user.userId);
		}
		return remaining;
	})();

	const manager = req.app.locals.groupManager;
	if (manager) manager.cancelOrder(id);

	res.json({ success: true, refunded: cancelled });
});

router.get('/events', (req, res, next) => {
	if (req.query.token && !req.headers.authorization) {
		req.headers.authorization = 'Bearer ' + req.query.token;
	}
	next();
}, verifyUser, (req, res) => {
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
		'X-Accel-Buffering': 'no'
	});
	res.write(': hello\n\n');
	const hb = setInterval(() => { try { res.write('event: heartbeat\ndata: {}\n\n'); } catch {} }, 30000);
	const manager = req.app.locals.groupManager;
	if (manager) manager.addSSEClient(res, req.user.userId);
	res.on('close', () => clearInterval(hb));
});

module.exports = router;
