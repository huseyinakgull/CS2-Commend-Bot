const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config.json');
let _db = null;
try { _db = require('../database'); } catch { _db = null; }

function tokenHash(token) {
	return crypto.createHash('sha256').update(token).digest('hex');
}

function _verifyJwtDual(token) {
	try {
		return { decoded: jwt.verify(token, config.jwtSecret), viaOld: false };
	} catch (primaryErr) {
		if (config.jwtSecretOld) {
			try {
				return { decoded: jwt.verify(token, config.jwtSecretOld), viaOld: true };
			} catch {  }
		}
		throw primaryErr;
	}
}

function verifyUser(req, res, next) {
	const token = req.headers.authorization?.replace('Bearer ', '');
	if (!token) return res.status(401).json({ error: 'Authentication required' });

	try {
		const { decoded, viaOld } = _verifyJwtDual(token);
		if (_db && typeof _db.isJwtRevoked === 'function') {
			if (_db.isJwtRevoked(tokenHash(token))) {
				return res.status(401).json({ error: 'Token revoked (logout)' });
			}
		}
		req.user = decoded;
		req._jwtToken = token;
		req._jwtViaOldSecret = viaOld;
		next();
	} catch {
		return res.status(401).json({ error: 'Invalid or expired token' });
	}
}

function verifyAdmin(req, res, next) {
	const token = req.headers.authorization?.replace('Bearer ', '');
	if (!token) return res.status(401).json({ error: 'Authentication required' });

	try {
		const { decoded, viaOld } = _verifyJwtDual(token);
		if (!decoded.isAdmin) return res.status(403).json({ error: 'Admin access required' });
		if (_db && typeof _db.isJwtRevoked === 'function') {
			if (_db.isJwtRevoked(tokenHash(token))) {
				return res.status(401).json({ error: 'Token revoked (logout)' });
			}
		}
		req.user = decoded;
		req._jwtToken = token;
		req._jwtViaOldSecret = viaOld;
		next();
	} catch {
		return res.status(401).json({ error: 'Invalid or expired token' });
	}
}

const RATE_LIMIT_MAX_KEYS = parseInt(process.env.RATE_LIMIT_MAX_KEYS || '5000', 10);
const rateLimitBuckets = new Map();

function _bucketTouch(key, value) {
	if (rateLimitBuckets.has(key)) rateLimitBuckets.delete(key);
	rateLimitBuckets.set(key, value);

	while (rateLimitBuckets.size > RATE_LIMIT_MAX_KEYS) {
		const oldestKey = rateLimitBuckets.keys().next().value;
		rateLimitBuckets.delete(oldestKey);
	}
}

setInterval(() => {
	const now = Date.now();
	for (const [key, timestamps] of rateLimitBuckets.entries()) {
		const filtered = timestamps.filter(t => now - t < 300000);
		if (filtered.length === 0) {
			rateLimitBuckets.delete(key);
		} else {
			rateLimitBuckets.set(key, filtered);
		}
	}
}, 5 * 60 * 1000);

const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function isLocalhost(ip) { return LOCALHOST_IPS.has(ip); }

function rateLimit(maxRequests = 30, windowMs = 60000, prefix = 'global') {
	return (req, res, next) => {
		const ip = req.ip || req.socket.remoteAddress;

		if (isLocalhost(ip)) return next();

		if (blockedIPs.has(ip)) {
			const blockInfo = blockedIPs.get(ip);
			if (Date.now() < blockInfo.until) {
				const remainingSec = Math.ceil((blockInfo.until - Date.now()) / 1000);
				return res.status(403).json({
					error: 'IP temporarily blocked due to excessive requests',
					retryAfterSeconds: remainingSec
				});
			}
			blockedIPs.delete(ip);
		}

		const key = `${prefix}:${ip}`;
		const now = Date.now();

		const existing = rateLimitBuckets.get(key) || [];
		const timestamps = existing.filter(t => now - t < windowMs);
		timestamps.push(now);
		_bucketTouch(key, timestamps);

		const remaining = Math.max(0, maxRequests - timestamps.length);
		res.setHeader('X-RateLimit-Limit', maxRequests);
		res.setHeader('X-RateLimit-Remaining', remaining);
		res.setHeader('X-RateLimit-Reset', Math.ceil((now + windowMs) / 1000));

		if (timestamps.length > maxRequests) {
			return res.status(429).json({ error: 'Too many requests, please slow down' });
		}
		next();
	};
}

const authRateLimit = rateLimit(30, 60000, 'auth');
const apiRateLimit = rateLimit(300, 60000, 'api');
const strictRateLimit = rateLimit(20, 60000, 'strict');

const IP_TRACKING_MAX_KEYS = parseInt(process.env.IP_TRACKING_MAX_KEYS || '20000', 10);
const blockedIPs = new Map();
const failedAttempts = new Map();

function _ipMapTouch(map, key, value) {
	if (map.has(key)) map.delete(key);
	map.set(key, value);
	while (map.size > IP_TRACKING_MAX_KEYS) {
		const oldest = map.keys().next().value;
		map.delete(oldest);
	}
}

setInterval(() => {
	const now = Date.now();
	for (const [ip, info] of blockedIPs.entries()) {
		if (now >= info.until) blockedIPs.delete(ip);
	}
	for (const [ip, info] of failedAttempts.entries()) {
		if (now - info.firstAttempt > 30 * 60 * 1000) failedAttempts.delete(ip);
	}
}, 10 * 60 * 1000);

function recordFailedAttempt(ip, maxFails = 20, windowMs = 300000, blockDurationMs = 900000) {
	const now = Date.now();

	if (!failedAttempts.has(ip)) {
		_ipMapTouch(failedAttempts, ip, { count: 1, firstAttempt: now });
		return;
	}

	const record = failedAttempts.get(ip);

	if (now - record.firstAttempt > windowMs) {
		_ipMapTouch(failedAttempts, ip, { count: 1, firstAttempt: now });
		return;
	}

	record.count++;
	_ipMapTouch(failedAttempts, ip, record);

	if (record.count >= maxFails) {
		_ipMapTouch(blockedIPs, ip, {
			until: now + blockDurationMs,
			reason: `Exceeded ${maxFails} failed attempts`
		});
		failedAttempts.delete(ip);
		logEvent('security', `IP blocked: ${ip} - exceeded ${maxFails} failed attempts`);
	}
}

function isIPBlocked(ip) {
	if (!blockedIPs.has(ip)) return false;
	const info = blockedIPs.get(ip);
	if (Date.now() >= info.until) {
		blockedIPs.delete(ip);
		return false;
	}
	return true;
}

function csrfGenerate(req, res, next) {
	const existing = req.cookies?.csrf_token;
	if (existing && /^[a-f0-9]{64}$/.test(existing)) {
		req.csrfToken = existing;
		return next();
	}
	const token = crypto.randomBytes(32).toString('hex');
	res.cookie('csrf_token', token, {
		httpOnly: false,
		sameSite: 'lax',
		secure: config.useHTTPS || (process.env.NODE_ENV === 'production'),
		maxAge: 24 * 3600 * 1000,
		path: '/'
	});
	req.csrfToken = token;
	next();
}

function csrfValidate(req, res, next) {
	if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
		return next();
	}

	const cookieToken = req.cookies?.csrf_token;
	const headerToken = req.headers['x-csrf-token'];

	if (!cookieToken || !headerToken) {
		return res.status(403).json({ error: 'CSRF token missing' });
	}

	if (cookieToken.length !== headerToken.length) {
		return res.status(403).json({ error: 'CSRF token invalid' });
	}

	const valid = crypto.timingSafeEqual(
		Buffer.from(cookieToken, 'utf8'),
		Buffer.from(headerToken, 'utf8')
	);

	if (!valid) {
		return res.status(403).json({ error: 'CSRF token invalid' });
	}

	next();
}

function sanitizeInput(req, res, next) {
	if (req.body && typeof req.body === 'object') {
		req.body = sanitizeObject(req.body);
	}
	if (req.query && typeof req.query === 'object') {
		req.query = sanitizeObject(req.query);
	}
	next();
}

function sanitizeObject(obj) {
	const sanitized = {};
	for (const [key, value] of Object.entries(obj)) {
		if (typeof value === 'string') {
			sanitized[key] = sanitizeString(value);
		} else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			sanitized[key] = sanitizeObject(value);
		} else if (Array.isArray(value)) {
			sanitized[key] = value.map(v =>
				typeof v === 'string' ? sanitizeString(v) :
				typeof v === 'object' && v !== null ? sanitizeObject(v) : v
			);
		} else {
			sanitized[key] = value;
		}
	}
	return sanitized;
}

function sanitizeString(str) {
	return str
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#x27;');
}

let _metricsRef = null;
try { _metricsRef = require('../lib/metrics'); } catch { _metricsRef = null; }

function requestLogger(req, res, next) {
	const start = Date.now();
	const ip = req.ip || req.socket.remoteAddress;

	res.on('finish', () => {
		const duration = Date.now() - start;
		const logLine = `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - ${res.statusCode} - ${ip} - ${duration}ms`;

		if (_metricsRef) {
			try { _metricsRef.recordRequest(req.method, req.originalUrl, res.statusCode, duration); } catch {}
		}

		const isServerError = res.statusCode >= 500;
		const isSlow = duration > 1000;
		if (isServerError || isSlow) {
			console.log(`\x1b[36m[REQ]\x1b[0m ${logLine}`);
		}

		requestLog.push({
			timestamp: new Date().toISOString(),
			method: req.method,
			path: req.originalUrl,
			status: res.statusCode,
			ip,
			duration
		});
		if (requestLog.length > 1000) {
			requestLog.splice(0, requestLog.length - 1000);
		}
	});

	next();
}

const requestLog = [];

const eventLog = [];

function logEvent(type, message, meta = {}) {
	const entry = {
		timestamp: new Date().toISOString(),
		type,
		message,
		...meta
	};
	eventLog.push(entry);
	if (eventLog.length > 5000) {
		eventLog.splice(0, eventLog.length - 5000);
	}
	console.log(`\x1b[33m[${type.toUpperCase()}]\x1b[0m ${message}`);
}

module.exports = {
	verifyUser,
	verifyAdmin,
	rateLimit,
	authRateLimit,
	apiRateLimit,
	strictRateLimit,
	csrfGenerate,
	csrfValidate,
	sanitizeInput,
	requestLogger,
	recordFailedAttempt,
	isIPBlocked,
	blockedIPs,
	requestLog,
	eventLog,
	logEvent,
	tokenHash,
	rateLimitBuckets
};
