const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../database');
const config = require('../config.json');
const { verifyPassword } = require('../lib/password');
const { rateLimit } = require('../middleware/auth');

const router = express.Router();

const TOKEN_TTL_HOURS = 24;
const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function currentPeriod() {
	const d = new Date();
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, '0');
	return `${y}-${m}`;
}

function ensurePeriod(reseller) {
	const now = currentPeriod();
	if (reseller.usage_period !== now) {
		db.prepare(`
			UPDATE resellers
			SET usage_commend = 0, usage_hours = 0, usage_group = 0, usage_period = ?
			WHERE id = ?
		`).run(now, reseller.id);
		reseller.usage_commend = 0;
		reseller.usage_hours = 0;
		reseller.usage_group = 0;
		reseller.usage_period = now;
	}
	return reseller;
}

function addAudit(resellerId, action, details, req) {
	try {
		const ip = req && (req.ip || (req.socket && req.socket.remoteAddress)) || null;
		const blob = typeof details === 'object' ? JSON.stringify(details) : (details || null);
		db.prepare('INSERT INTO reseller_audit (reseller_id, action, details, ip) VALUES (?, ?, ?, ?)')
			.run(resellerId, action, blob, ip);
	} catch {}
}

function generateCode() {
	const bytes = crypto.randomBytes(12);
	let out = '';
	for (let i = 0; i < 12; i++) {
		if (i > 0 && i % 4 === 0) out += '-';
		out += CODE_CHARS[bytes[i] % CODE_CHARS.length];
	}
	return out;
}

function verifyReseller(req, res, next) {
	const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
	if (!token) return res.status(401).json({ error: 'auth_required' });

	try {
		const decoded = jwt.verify(token, config.jwtSecret);
		if (!decoded.isReseller || !decoded.resellerId) {
			return res.status(403).json({ error: 'not_a_reseller' });
		}

		const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(decoded.resellerId);
		if (!reseller) return res.status(401).json({ error: 'account_not_found' });
		if (reseller.status !== 'active') return res.status(403).json({ error: 'account_suspended' });

		const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
		const sess = db.prepare('SELECT * FROM reseller_sessions WHERE token_hash = ? AND revoked = 0 AND expires_at > datetime(\'now\')').get(tokenHash);
		if (!sess) return res.status(401).json({ error: 'session_invalid' });

		ensurePeriod(reseller);

		req.reseller = reseller;
		req.resellerTokenHash = tokenHash;
		next();
	} catch (err) {
		return res.status(401).json({ error: 'invalid_token' });
	}
}

router.post('/login', rateLimit(10, 60000, 'reseller-login'), (req, res) => {
	const { username, password } = req.body || {};
	const ip = req.ip || (req.socket && req.socket.remoteAddress);

	if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
		return res.status(400).json({ error: 'missing_credentials' });
	}

	const cleanUser = String(username).trim().slice(0, 64);
	const reseller = db.prepare('SELECT * FROM resellers WHERE username = ?').get(cleanUser);
	if (!reseller) return res.status(401).json({ error: 'invalid_credentials' });
	if (reseller.status !== 'active') return res.status(403).json({ error: 'account_suspended' });

	if (!verifyPassword(password, reseller.password_salt, reseller.password_hash)) {
		addAudit(reseller.id, 'login_failed', { ip }, req);
		return res.status(401).json({ error: 'invalid_credentials' });
	}

	ensurePeriod(reseller);

	const token = jwt.sign(
		{ resellerId: reseller.id, isReseller: true, username: reseller.username },
		config.jwtSecret,
		{ expiresIn: TOKEN_TTL_HOURS + 'h' }
	);

	const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
	const expires = new Date(Date.now() + TOKEN_TTL_HOURS * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

	db.prepare(`
		INSERT INTO reseller_sessions (reseller_id, token_hash, ip, user_agent, expires_at)
		VALUES (?, ?, ?, ?, ?)
	`).run(reseller.id, tokenHash, ip || null, (req.headers['user-agent'] || '').slice(0, 255), expires);

	db.prepare('UPDATE resellers SET last_login = datetime(\'now\') WHERE id = ?').run(reseller.id);
	addAudit(reseller.id, 'login_success', { ip }, req);

	res.json({
		token,
		reseller: {
			id: reseller.id,
			username: reseller.username,
			displayName: reseller.display_name,
			tier: reseller.tier,
			limits: {
				commend: reseller.limit_commend,
				hours: reseller.limit_hours,
				group: reseller.limit_group
			},
			usage: {
				commend: reseller.usage_commend,
				hours: reseller.usage_hours,
				group: reseller.usage_group,
				period: reseller.usage_period
			}
		}
	});
});

router.post('/logout', verifyReseller, (req, res) => {
	db.prepare('UPDATE reseller_sessions SET revoked = 1 WHERE token_hash = ?').run(req.resellerTokenHash);
	addAudit(req.reseller.id, 'logout', null, req);
	res.json({ success: true });
});

router.get('/me', verifyReseller, (req, res) => {
	const r = req.reseller;
	res.json({
		id: r.id,
		username: r.username,
		displayName: r.display_name,
		contact: r.contact,
		tier: r.tier,
		status: r.status,
		limits: { commend: r.limit_commend, hours: r.limit_hours, group: r.limit_group },
		usage: { commend: r.usage_commend, hours: r.usage_hours, group: r.usage_group, period: r.usage_period },
		total: { commend: r.total_commend, hours: r.total_hours, group: r.total_group, codes: r.total_codes },
		createdAt: r.created_at,
		lastLogin: r.last_login
	});
});

router.post('/codes/generate', verifyReseller, rateLimit(30, 60000, 'reseller-gen'), (req, res) => {
	try {
		const { count, balance, productType, expiresAt } = req.body || {};
		const c = parseInt(count, 10);
		const bal = parseInt(balance, 10);
		const pt = ['commend', 'hours', 'group'].includes(productType) ? productType : null;

		if (!c || c <= 0 || c > 100) return res.status(400).json({ error: 'invalid_count', min: 1, max: 100 });
		if (!bal || bal <= 0 || bal > 100000) return res.status(400).json({ error: 'invalid_balance', min: 1, max: 100000 });
		if (!pt) return res.status(400).json({ error: 'invalid_product_type' });

		const r = req.reseller;
		const limitKey = 'limit_' + pt;
		const usageKey = 'usage_' + pt;
		const limitVal = r[limitKey];
		const usageVal = r[usageKey];

		if (limitVal === 0) return res.status(403).json({ error: 'product_not_permitted', productType: pt });

		const totalUnits = c * bal;

		if (limitVal > 0) {
			const remaining = limitVal - usageVal;
			if (totalUnits > remaining) {
				return res.status(403).json({
					error: 'limit_exceeded',
					productType: pt,
					limit: limitVal,
					used: usageVal,
					remaining,
					requested: totalUnits
				});
			}
		}

		let expIso = null;
		if (expiresAt) {
			const d = new Date(expiresAt);
			if (!isNaN(d.getTime())) expIso = d.toISOString().replace('T', ' ').slice(0, 19);
		}

		const generated = [];
		const runTxn = db.transaction(() => {
			const insert = db.prepare(`
				INSERT INTO codes (code, balance, initial_balance, expires_at, product_type, reseller_id)
				VALUES (?, ?, ?, ?, ?, ?)
			`);
			for (let i = 0; i < c; i++) {
				let code = generateCode();
				let tries = 0;
				while (tries < 6) {
					try {
						insert.run(code, bal, bal, expIso, pt, r.id);
						generated.push({ code, balance: bal, productType: pt });
						break;
					} catch { code = generateCode(); tries++; }
				}
			}

			const totalGenerated = generated.length * bal;
			const updateSql = `
				UPDATE resellers
				SET ${usageKey} = ${usageKey} + ?,
				    total_${pt} = total_${pt} + ?,
				    total_codes = total_codes + ?
				WHERE id = ?
			`;
			db.prepare(updateSql).run(totalGenerated, totalGenerated, generated.length, r.id);
		});
		runTxn();

		addAudit(r.id, 'codes_generated', { productType: pt, count: generated.length, balance: bal, totalUnits: generated.length * bal }, req);

		const updated = db.prepare('SELECT * FROM resellers WHERE id = ?').get(r.id);

		res.json({
			success: true,
			generated: generated.length,
			codes: generated,
			usage: { commend: updated.usage_commend, hours: updated.usage_hours, group: updated.usage_group, period: updated.usage_period }
		});
	} catch (err) {
		console.error('[reseller] generate error:', err);
		res.status(500).json({ error: 'internal_error' });
	}
});

router.get('/codes', verifyReseller, (req, res) => {
	const page = Math.max(1, parseInt(req.query.page, 10) || 1);
	const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
	const offset = (page - 1) * limit;

	const filter = req.query.filter || 'all';
	const pt = req.query.productType;

	let where = 'reseller_id = ?';
	const params = [req.reseller.id];
	if (filter === 'used') where += ' AND is_used = 1';
	else if (filter === 'unused') where += ' AND is_used = 0';
	if (['commend', 'hours', 'group'].includes(pt)) { where += ' AND product_type = ?'; params.push(pt); }

	const rows = db.prepare(`
		SELECT id, code, balance, initial_balance, is_used, used_by_user_id, product_type, created_at, expires_at
		FROM codes WHERE ${where}
		ORDER BY id DESC
		LIMIT ? OFFSET ?
	`).all(...params, limit, offset);

	const total = db.prepare(`SELECT COUNT(*) as c FROM codes WHERE ${where}`).get(...params).c;

	res.json({
		codes: rows.map(c => ({
			id: c.id,
			code: c.code,
			balance: c.balance,
			initialBalance: c.initial_balance,
			isUsed: !!c.is_used,
			productType: c.product_type || 'commend',
			createdAt: c.created_at,
			expiresAt: c.expires_at
		})),
		total,
		page,
		limit,
		totalPages: Math.ceil(total / limit) || 1
	});
});

router.get('/stats', verifyReseller, (req, res) => {
	const r = req.reseller;
	const breakdown = db.prepare(`
		SELECT product_type, is_used, COUNT(*) as cnt, COALESCE(SUM(initial_balance), 0) as total_bal
		FROM codes WHERE reseller_id = ?
		GROUP BY product_type, is_used
	`).all(r.id);

	const recent = db.prepare(`
		SELECT DATE(created_at) as day, product_type, COUNT(*) as cnt, COALESCE(SUM(initial_balance), 0) as total
		FROM codes
		WHERE reseller_id = ? AND created_at >= datetime('now', '-30 days')
		GROUP BY DATE(created_at), product_type
		ORDER BY day ASC
	`).all(r.id);

	res.json({
		limits: { commend: r.limit_commend, hours: r.limit_hours, group: r.limit_group },
		usage: { commend: r.usage_commend, hours: r.usage_hours, group: r.usage_group, period: r.usage_period },
		total: { commend: r.total_commend, hours: r.total_hours, group: r.total_group, codes: r.total_codes },
		breakdown,
		recent
	});
});

router.get('/audit', verifyReseller, (req, res) => {
	const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
	const rows = db.prepare(`
		SELECT id, action, details, ip, created_at
		FROM reseller_audit
		WHERE reseller_id = ?
		ORDER BY id DESC
		LIMIT ?
	`).all(req.reseller.id, limit);
	res.json({ audit: rows });
});

module.exports = router;
module.exports.verifyReseller = verifyReseller;
