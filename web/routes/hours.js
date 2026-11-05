const express = require('express');
const db = require('../database');
const config = require('../config.json');
const { verifyUser, rateLimit } = require('../middleware/auth');
const { blockIfMaintenance } = require('../middleware/maintenance');
const { encryptJson } = require('../lib/crypto-util');

const router = express.Router();

const MIN_HOURS = 10;
const MAX_HOURS = 5000;
const USERNAME_RE = /^[a-zA-Z0-9_\-\.@]{3,64}$/;

const HOURS_DISABLED = true;
function blockIfHoursDisabled(req, res, next) {
	if (HOURS_DISABLED) {
		return res.status(503).json({
			error: 'service_unavailable',
			message: 'Saat boost servisi şu anda geçici olarak devre dışıdır. Daha sonra tekrar deneyin.'
		});
	}
	next();
}

function requireHoursProduct(req, res, next) {
	const pt = (req.user && req.user.productType) || 'commend';
	if (pt !== 'hours') {
		return res.status(403).json({ error: 'wrong_product_type', required: 'hours', current: pt });
	}
	next();
}

router.post('/start',
	blockIfHoursDisabled,
	verifyUser,
	blockIfMaintenance,
	requireHoursProduct,
	rateLimit(5, 60000, 'hours'),
	(req, res) => {
		try {
			const { steamUsername, steamPassword, sharedSecret, hours, appid } = req.body || {};

			if (!steamUsername || !USERNAME_RE.test(String(steamUsername).trim())) {
				return res.status(400).json({ error: 'invalid_username' });
			}
			if (!steamPassword || typeof steamPassword !== 'string' || steamPassword.length < 4 || steamPassword.length > 200) {
				return res.status(400).json({ error: 'invalid_password' });
			}
			if (sharedSecret != null && (typeof sharedSecret !== 'string' || sharedSecret.length > 200)) {
				return res.status(400).json({ error: 'invalid_shared_secret' });
			}
			const hoursNum = parseInt(hours, 10);
			if (!Number.isFinite(hoursNum) || hoursNum < MIN_HOURS || hoursNum > MAX_HOURS) {
				return res.status(400).json({ error: 'invalid_hours', min: MIN_HOURS, max: MAX_HOURS });
			}
			const appIdNum = parseInt(appid, 10) || 730;
			if (![730, 570, 440, 252490, 578080, 271590, 292030].includes(appIdNum)) {
				return res.status(400).json({ error: 'unsupported_appid' });
			}

			const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId);
			if (!user) return res.status(404).json({ error: 'user_not_found' });
			if (user.banned) return res.status(403).json({ error: 'account_banned' });
			if ((user.product_type || 'commend') !== 'hours') {
				return res.status(403).json({ error: 'wrong_product_type' });
			}
			if (user.balance < hoursNum) {
				return res.status(400).json({ error: 'insufficient_balance', required: hoursNum, have: user.balance });
			}

			const creds = { username: String(steamUsername).trim(), password: steamPassword, sharedSecret: sharedSecret || null };
			const blob = encryptJson(creds, config.jwtSecret);

			const created = db.transaction(() => {
				const deduct = db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?')
					.run(hoursNum, user.id, hoursNum);
				if (deduct.changes === 0) throw new Error('balance_deduct_race');

				const ins = db.prepare(`
					INSERT INTO hours_boost_sessions
					  (user_id, steam_username, appid, requested_hours, credential_blob, status)
					VALUES (?, ?, ?, ?, ?, 'pending')
				`).run(user.id, creds.username, appIdNum, hoursNum, blob);

				return db.prepare('SELECT * FROM hours_boost_sessions WHERE id = ?').get(ins.lastInsertRowid);
			})();

			const manager = req.app.locals.hoursManager;
			if (manager) manager.startFromRow(created);

			res.json({
				success: true,
				session: {
					id: created.id,
					username: created.steam_username,
					appid: created.appid,
					requestedHours: created.requested_hours,
					hoursDone: 0,
					status: created.status
				}
			});
		} catch (err) {
			console.error('[hours] start error:', err);
			res.status(500).json({ error: 'internal_error', message: 'Boost oturumu başlatılamadı' });
		}
	}
);

router.get('/list', verifyUser, requireHoursProduct, (req, res) => {
	const manager = req.app.locals.hoursManager;
	const rows = manager
		? manager.listUserSessions(req.user.userId)
		: db.prepare(`
			SELECT id, steam_username, steam_persona, steam_id64, appid,
			       requested_hours, hours_done, status, last_error,
			       started_at, last_tick, completed_at, created_at
			FROM hours_boost_sessions WHERE user_id = ?
			ORDER BY id DESC
		`).all(req.user.userId);
	res.json({ sessions: rows });
});

router.get('/status/:id', verifyUser, requireHoursProduct, (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
	const row = db.prepare('SELECT * FROM hours_boost_sessions WHERE id = ? AND user_id = ?').get(id, req.user.userId);
	if (!row) return res.status(404).json({ error: 'session_not_found' });
	res.json({
		id: row.id,
		username: row.steam_username,
		persona: row.steam_persona,
		steamId: row.steam_id64,
		appid: row.appid,
		requestedHours: row.requested_hours,
		hoursDone: row.hours_done,
		status: row.status,
		lastError: row.last_error,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		createdAt: row.created_at
	});
});

router.post('/stop/:id', verifyUser, requireHoursProduct, (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
	const row = db.prepare('SELECT * FROM hours_boost_sessions WHERE id = ? AND user_id = ?').get(id, req.user.userId);
	if (!row) return res.status(404).json({ error: 'session_not_found' });
	if (!['pending', 'running'].includes(row.status)) {
		return res.status(400).json({ error: 'not_stoppable', status: row.status });
	}

	const manager = req.app.locals.hoursManager;
	let refund = 0;
	if (manager) {
		refund = manager.stopSession(id, 'user_stopped');
	} else {
		refund = Math.max(0, Math.floor(row.requested_hours - row.hours_done));
		db.prepare("UPDATE hours_boost_sessions SET status='cancelled', completed_at=datetime('now') WHERE id=?").run(id);
	}

	if (refund > 0) {
		db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(refund, req.user.userId);
	}

	res.json({ success: true, refundedHours: refund });
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

	const manager = req.app.locals.hoursManager;
	if (manager) manager.addSSEClient(res, req.user.userId);

	res.on('close', () => clearInterval(hb));
});

module.exports = router;
