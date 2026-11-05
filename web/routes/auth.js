const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../database');
const config = require('../config.json');
const { safeEqual } = require('../lib/password');
const { verifyUser, verifyAdmin, authRateLimit, recordFailedAttempt, logEvent, tokenHash } = require('../middleware/auth');

const router = express.Router();

function _signAndTrack(payload, expiresIn, subjectType, subjectId, req) {
	const token = jwt.sign(payload, config.jwtSecret, { expiresIn });
	try {
		const decoded = jwt.decode(token);
		const expiresAtIso = decoded && decoded.exp ? new Date(decoded.exp * 1000).toISOString() : null;
		if (expiresAtIso && typeof db.recordJwtSession === 'function') {
			db.recordJwtSession(
				tokenHash(token),
				subjectType,
				subjectId,
				expiresAtIso,
				req.ip || (req.socket && req.socket.remoteAddress) || null,
				req.headers['user-agent'] || null
			);
		}
	} catch {  }
	return token;
}

router.use(authRateLimit);

const loginAttempts = new Map();

setInterval(() => {
	const now = Date.now();
	for (const [key, info] of loginAttempts.entries()) {
		if (info.lockedUntil && now > info.lockedUntil) {
			loginAttempts.delete(key);
		} else if (now - info.firstAttempt > 30 * 60 * 1000) {
			loginAttempts.delete(key);
		}
	}
}, 10 * 60 * 1000);

function checkBruteForce(key) {
	const record = loginAttempts.get(key);
	if (!record) return { blocked: false };

	if (record.lockedUntil) {
		if (Date.now() < record.lockedUntil) {
			const remainingSec = Math.ceil((record.lockedUntil - Date.now()) / 1000);
			return { blocked: true, remainingSec };
		}
		loginAttempts.delete(key);
		return { blocked: false };
	}

	return { blocked: false };
}

function recordLoginFailure(key, maxAttempts = 5, lockDurationMs = 15 * 60 * 1000) {
	const now = Date.now();
	const record = loginAttempts.get(key) || { count: 0, firstAttempt: now };

	if (now - record.firstAttempt > lockDurationMs) {
		loginAttempts.set(key, { count: 1, firstAttempt: now });
		return;
	}

	record.count++;
	if (record.count >= maxAttempts) {
		record.lockedUntil = now + lockDurationMs;
		logEvent('security', `Account locked: ${key} after ${maxAttempts} failed attempts`);
	}
	loginAttempts.set(key, record);
}

function clearLoginFailures(key) {
	loginAttempts.delete(key);
}

router.post('/login', (req, res) => {
	const { code, referralCode } = req.body;
	const ip = req.ip || req.socket.remoteAddress;

	if (!code || typeof code !== 'string' || code.trim().length === 0) {
		return res.status(400).json({ error: 'Code is required' });
	}

	const cleanCode = code.trim().toUpperCase().slice(0, 20).replace(/[^A-Z0-9-]/g, '');

	if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(cleanCode)) {
		return res.status(400).json({ error: 'Invalid code format' });
	}

	const codeLock = checkBruteForce(`code:${cleanCode}`);
	if (codeLock.blocked) {
		return res.status(429).json({
			error: 'Too many failed attempts for this code. Try again later.',
			retryAfterSeconds: codeLock.remainingSec
		});
	}

	const ipLock = checkBruteForce(`ip:${ip}`);
	if (ipLock.blocked) {
		return res.status(429).json({
			error: 'Too many failed login attempts. Try again later.',
			retryAfterSeconds: ipLock.remainingSec
		});
	}

	const codeRow = db.prepare('SELECT * FROM codes WHERE code = ?').get(cleanCode);
	if (!codeRow) {
		recordLoginFailure(`code:${cleanCode}`);
		recordLoginFailure(`ip:${ip}`);
		recordFailedAttempt(ip);
		logEvent('auth', `Login failed: invalid code`, { ip, code: cleanCode });
		return res.status(404).json({ error: 'Invalid code' });
	}

	if (codeRow.is_used) {
		const user = db.prepare('SELECT * FROM users WHERE code_id = ?').get(codeRow.id);
		if (!user) {
			return res.status(400).json({ error: 'Code already used but user not found' });
		}

		db.prepare('UPDATE users SET last_active = datetime(\'now\') WHERE id = ?').run(user.id);

		const productType = user.product_type || codeRow.product_type || 'commend';

		const token = _signAndTrack(
			{ userId: user.id, codeId: codeRow.id, isAdmin: false, productType },
			'24h', 'user', user.id, req
		);

		clearLoginFailures(`code:${cleanCode}`);
		clearLoginFailures(`ip:${ip}`);
		logEvent('auth', `Login success: user ${user.id}`, { ip, userId: user.id });

		return res.json({
			token,
			user: {
				id: user.id,
				balance: user.balance,
				steamId: user.steam_id,
				steamName: user.steam_name,
				productType
			}
		});
	}

	const cleanReferral = referralCode
		? String(referralCode).trim().toUpperCase().slice(0, 20).replace(/[^A-Z0-9-]/g, '')
		: null;

	const productType = codeRow.product_type || 'commend';

	const result = db.prepare(
		'INSERT INTO users (code_id, balance, referral_code, product_type) VALUES (?, ?, ?, ?)'
	).run(codeRow.id, codeRow.balance, cleanReferral, productType);

	db.prepare('UPDATE codes SET is_used = 1, used_by_user_id = ? WHERE id = ?')
		.run(result.lastInsertRowid, codeRow.id);

	const token = _signAndTrack(
		{ userId: result.lastInsertRowid, codeId: codeRow.id, isAdmin: false, productType },
		'24h', 'user', result.lastInsertRowid, req
	);

	clearLoginFailures(`code:${cleanCode}`);
	clearLoginFailures(`ip:${ip}`);
	logEvent('auth', `New user registered: ${result.lastInsertRowid}`, { ip, userId: result.lastInsertRowid });

	res.json({
		token,
		user: {
			id: result.lastInsertRowid,
			balance: codeRow.balance,
			steamId: null,
			steamName: null,
			productType
		}
	});
});

router.post('/admin', (req, res) => {
	const { password } = req.body;
	const ip = req.ip || req.socket.remoteAddress;

	const lock = checkBruteForce(`admin:${ip}`);
	if (lock.blocked) {
		return res.status(429).json({
			error: 'Too many failed attempts. Try again later.',
			retryAfterSeconds: lock.remainingSec
		});
	}

	if (!safeEqual(password, config.adminPassword)) {
		recordLoginFailure(`admin:${ip}`);
		recordFailedAttempt(ip);
		logEvent('auth', `Admin login failed`, { ip });
		return res.status(401).json({ error: 'Invalid admin password' });
	}

	clearLoginFailures(`admin:${ip}`);
	logEvent('auth', `Admin login success`, { ip });

	const token = _signAndTrack({ isAdmin: true }, '12h', 'admin', null, req);

	res.json({ token });
});

router.post('/refresh', verifyUser, (req, res) => {
	const payload = { ...req.user };
	delete payload.iat;
	delete payload.exp;

	const expiresIn = payload.isAdmin ? '12h' : '24h';
	const subjectType = payload.isAdmin ? 'admin' : 'user';
	const subjectId  = payload.isAdmin ? null : payload.userId;

	const token = _signAndTrack(payload, expiresIn, subjectType, subjectId, req);

	res.json({ token });
});

router.post('/logout', verifyUser, (req, res) => {
	try {
		if (req._jwtToken && typeof db.revokeJwt === 'function') {
			db.revokeJwt(tokenHash(req._jwtToken), 'user_logout');
		}
		logEvent('auth', `Logout: user ${req.user.userId || 'admin'}`, { ip: req.ip });
	} catch {}
	res.json({ ok: true });
});

router.get('/user', verifyUser, (req, res) => {
	const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId);
	if (!user) {
		return res.status(404).json({ error: 'User not found' });
	}

	res.json({
		id: user.id,
		balance: user.balance,
		steamId: user.steam_id,
		steamName: user.steam_name,
		productType: user.product_type || 'commend',
		createdAt: user.created_at
	});
});

module.exports = router;
