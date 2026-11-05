const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch {}

const express = require('express');
const config = require('./config.json');
const {
	rateLimit, apiRateLimit, verifyUser, verifyAdmin,
	sanitizeInput, requestLogger,
	csrfGenerate, csrfValidate
} = require('./middleware/auth');
const db = require('./database');

const app = express();
const startTime = Date.now();

try {
	const compression = require('compression');
	app.use(compression({
		level: 6,
		threshold: 1024,
		filter: (req, res) => {
			if (req.headers['x-no-compression']) return false;
			const type = res.getHeader('Content-Type') || '';
			if (/^(image\/(?!svg)|video\/|audio\/|application\/(zip|gzip|brotli|octet-stream|font-woff))/i.test(type)) {
				return false;
			}
			return compression.filter(req, res);
		}
	}));
} catch {
}

try {
	const botConfig = require('../config.json');
	if (botConfig.steamApiKey) {
		app.locals.steamApiKey = botConfig.steamApiKey;
	}
} catch {
}

if (!app.locals.steamApiKey && config.steamApiKey) {
	app.locals.steamApiKey = config.steamApiKey;
}

const steamProfileCache = new Map();
const STEAM_CACHE_TTL = 5 * 60 * 1000;

function getCachedProfile(steamid) {
	const entry = steamProfileCache.get(steamid);
	if (entry && Date.now() - entry.timestamp < STEAM_CACHE_TTL) {
		return entry.data;
	}
	if (entry) {
		steamProfileCache.delete(steamid);
	}
	return null;
}

function setCachedProfile(steamid, data) {
	if (steamProfileCache.size > 1000) {
		const now = Date.now();
		for (const [key, val] of steamProfileCache) {
			if (now - val.timestamp > STEAM_CACHE_TTL) {
				steamProfileCache.delete(key);
			}
		}
		if (steamProfileCache.size > 1000) {
			steamProfileCache.clear();
		}
	}
	steamProfileCache.set(steamid, { data, timestamp: Date.now() });
}

let activeSSEConnections = 0;

app.use((req, res, next) => {
	const host = req.hostname || req.headers.host;
	if (host && host.startsWith('www.')) {
		const newHost = host.replace(/^www\./, '');
		return res.redirect(301, `${req.protocol}://${newHost}${req.originalUrl}`);
	}
	next();
});

const SUPPORTED_LANG_PREFIXES = ['en', 'de', 'ru', 'pl', 'pt', 'es', 'fr'];
app.use((req, res, next) => {
	if (req.method !== 'GET' || !req.query || !req.query.lang) return next();
	const lang = String(req.query.lang).toLowerCase();
	const { lang: _, ...restQuery } = req.query;
	const restQS = new URLSearchParams(restQuery).toString();
	const qsSuffix = restQS ? '?' + restQS : '';

	if (lang === 'tr') {
		return res.redirect(301, req.path + qsSuffix);
	}
	if (SUPPORTED_LANG_PREFIXES.includes(lang)) {
		const stripped = req.path.replace(/^\/(en|de|ru|pl|pt|es|fr)(\/|$)/, '/');
		return res.redirect(301, '/' + lang + (stripped === '/' ? '' : stripped) + qsSuffix);
	}
	return res.redirect(301, req.path + qsSuffix);
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false, limit: '5mb' }));

try {
	const cookieParser = require('cookie-parser');
	app.use(cookieParser());
} catch {
}

app.use(csrfGenerate);

app.use(requestLogger);

app.use(sanitizeInput);

app.use(apiRateLimit);

const allowedOrigins = config.corsOrigins || [];
app.use((req, res, next) => {
	const origin = req.headers.origin;

	if (allowedOrigins.length === 0) {
		res.setHeader('X-Content-Type-Options', 'nosniff');
	} else if (allowedOrigins.includes('*')) {
		res.setHeader('Access-Control-Allow-Origin', '*');
	} else if (origin && allowedOrigins.includes(origin)) {
		res.setHeader('Access-Control-Allow-Origin', origin);
		res.setHeader('Vary', 'Origin');
	}

	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
	res.setHeader('Access-Control-Allow-Credentials', 'true');
	res.setHeader('Access-Control-Max-Age', '86400');

	if (req.method === 'OPTIONS') {
		return res.sendStatus(204);
	}
	next();
});

app.use((req, res, next) => {
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('X-Frame-Options', 'DENY');
	res.setHeader('X-XSS-Protection', '1; mode=block');
	res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

	res.setHeader('Content-Security-Policy', [
		"default-src 'self'",
		"script-src 'self' 'unsafe-inline' https://embed.tawk.to https://*.tawk.to https://www.googletagmanager.com https://www.google-analytics.com",
		"script-src-elem 'self' 'unsafe-inline' https://embed.tawk.to https://*.tawk.to https://www.googletagmanager.com https://www.google-analytics.com",
		"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://embed.tawk.to https://*.tawk.to",
		"font-src 'self' https://fonts.gstatic.com https://embed.tawk.to https://*.tawk.to data:",
		"img-src 'self' data: blob: https://*.steamstatic.com https://avatars.steamstatic.com https://*.akamaihd.net https://*.tawk.to https://www.google-analytics.com https://www.googletagmanager.com",
		"connect-src 'self' https://api.steampowered.com https://*.tawk.to wss://*.tawk.to https://www.google-analytics.com https://*.google-analytics.com https://www.googletagmanager.com",
		"frame-src https://www.youtube-nocookie.com https://www.youtube.com https://*.tawk.to",
		"media-src 'self' data: blob: https://*.tawk.to",
		"frame-ancestors 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"upgrade-insecure-requests"
	].join('; '));

	res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

	res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

	next();
});

const fs = require('fs');
const { applyServerTokens } = require('./lib/server-tokens');

app.get(/^\/(lang\/[a-z]{2}\.json|[a-z0-9-]+\.html|blog\/[a-z0-9-]+\.html)$/, (req, res, next) => {
	const filePath = path.join(__dirname, 'public', req.path);
	fs.readFile(filePath, 'utf8', (err, text) => {
		if (err) return next();
		const isJson = filePath.endsWith('.json');
		res.set('Content-Type', (isJson ? 'application/json' : 'text/html') + '; charset=utf-8');
		res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
		res.send(applyServerTokens(text, isJson ? 'json' : 'html'));
	});
});

app.use(express.static(path.join(__dirname, 'public'), {
	dotfiles: 'deny',
	index: false,
	redirect: false,
	maxAge: '1d',
	setHeaders: (res, filePath) => {
		if (filePath.endsWith('.html')) {
			res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
			res.setHeader('Pragma', 'no-cache');
			res.setHeader('Expires', '0');
		}
		else if (/\.(jpg|jpeg|png|gif|webp|svg|ico)$/i.test(filePath)) {
			const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
			res.setHeader('Expires', expires.toUTCString());
			res.setHeader('Cache-Control', 'public, max-age=2592000');
		}
		else if (/admin\.(js|css)$/i.test(filePath)) {
			res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
			res.setHeader('Pragma', 'no-cache');
			res.setHeader('Expires', '0');
		}
		else if (/\.(js|css)$/i.test(filePath)) {
			const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
			res.setHeader('Expires', expires.toUTCString());
			res.setHeader('Cache-Control', 'public, max-age=604800');
		}
	}
}));

app.all('/api/admin/verify', (req, res) => {
	res.status(410).json({ error: 'endpoint_removed', use: '/api/auth/admin/login' });
});

app.get('/api/health', (req, res) => {
	res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/announcement', (req, res) => {
	res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
	res.set('Pragma', 'no-cache');
	res.set('Expires', '0');
	try {
		const db = require('./database');
		const raw = db.getSetting('announcement', null);
		if (!raw) return res.json({ active: false });
		let parsed;
		try { parsed = JSON.parse(raw); } catch { return res.json({ active: false }); }
		if (!parsed || typeof parsed !== 'object') return res.json({ active: false });
		if (!parsed.active) return res.json({ active: false });
		return res.json({
			active: true,
			level: ['info','warn','critical'].includes(parsed.level) ? parsed.level : 'info',
			title: typeof parsed.title === 'string' ? parsed.title.slice(0, 200) : '',
			body: typeof parsed.body === 'string' ? parsed.body.slice(0, 2000) : '',
			updatedAt: parsed.updatedAt || null
		});
	} catch (e) {
		return res.json({ active: false });
	}
});

app.get('/healthz', (req, res) => {
	const checks = { db: 'unknown', disk: 'unknown', processor: 'unknown' };
	let healthy = true;

	try {
		const db = require('./database');
		const r = db.prepare('SELECT 1 as ok').get();
		checks.db = (r && r.ok === 1) ? 'ok' : 'fail';
		if (checks.db !== 'ok') healthy = false;
	} catch (e) {
		checks.db = 'error: ' + e.message;
		healthy = false;
	}

	try {
		const fs = require('fs');
		const stat = fs.statfsSync ? fs.statfsSync(__dirname) : null;
		if (stat) {
			const freeMB = Math.round((stat.bavail * stat.bsize) / (1024 * 1024));
			checks.disk = freeMB > 500 ? `ok (${freeMB}MB free)` : `low (${freeMB}MB free)`;
			if (freeMB < 200) healthy = false;
		} else {
			checks.disk = 'skip (statfsSync unavailable)';
		}
	} catch (e) {
		checks.disk = 'error: ' + e.message;
	}

	try {
		const tp = app.locals.transactionProcessor;
		if (tp && typeof tp.isRunning === 'function') {
			checks.processor = tp.isRunning() ? 'ok' : 'stopped';
			if (!tp.isRunning()) healthy = false;
		} else if (tp) {
			checks.processor = 'present';
		} else {
			checks.processor = 'not_attached';
		}
	} catch (e) {
		checks.processor = 'error: ' + e.message;
	}

	const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
	res.status(healthy ? 200 : 503).json({
		status: healthy ? 'ok' : 'unhealthy',
		uptime_sec: uptimeSec,
		timestamp: new Date().toISOString(),
		checks
	});
});

app.get('/api/public/servers', (req, res) => {
	res.json(config.serverInfo || []);
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/user', csrfValidate, require('./routes/user'));
app.use('/api/admin', csrfValidate, require('./routes/admin'));
app.use('/api/admin/gamesatis', csrfValidate, require('./routes/gamesatis-admin'));
app.use('/api/admin/hesap', csrfValidate, require('./routes/hesap-admin'));
app.use('/api/admin/ggsel', csrfValidate, require('./routes/admin-ggsel'));
app.use('/api/hitl', require('./routes/hitl'));
app.use('/api/discord', require('./routes/discord'));
app.use('/api/free-commend', require('./routes/free-commend'));
app.use('/api/hours', csrfValidate, require('./routes/hours'));
app.use('/api/group', csrfValidate, require('./routes/group'));
app.use('/api/reseller', csrfValidate, require('./routes/reseller'));
app.use('/api/reseller-pricing', require('./routes/reseller-pricing'));
app.use('/api/reviews', csrfValidate, require('./routes/reviews'));
app.use('/api/trust-factor', require('./routes/trust-factor'));
app.use('/api/payments', require('./routes/payments'));

(function migrateGgsel() {
	try {
		const db = require('./database');
		db.setSetting('ggsel.token', '');
		db.setSetting('ggsel.strategy', '');
		db.setSetting('ggsel.custom_header', '');
	} catch (e) {
		console.warn('[ggsel] cleanup skip:', e.message);
	}
})();

app.get('/api/events', (req, res, next) => {
	if (req.query.token) {
		req.headers.authorization = 'Bearer ' + req.query.token;
	}
	next();
}, verifyUser, (req, res) => {
	activeSSEConnections++;

	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive'
	});

	const heartbeat = setInterval(() => {
		res.write('event: heartbeat\ndata: {}\n\n');
	}, 30000);

	if (app.locals.transactionProcessor) {
		app.locals.transactionProcessor.addSSEClient(res);
	}

	req.on('close', () => {
		activeSSEConnections--;
		clearInterval(heartbeat);
	});
});

const adminSSEClients = new Set();

app.get('/api/admin/events', (req, res, next) => {
	if (req.query.token) {
		req.headers.authorization = 'Bearer ' + req.query.token;
	}
	next();
}, verifyAdmin, (req, res) => {
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive'
	});

	adminSSEClients.add(res);

	const heartbeat = setInterval(() => {
		const data = {};
		if (app.locals.botManager) data.botStatus = app.locals.botManager.status;
		if (app.locals.transactionProcessor) data.processorStatus = app.locals.transactionProcessor.getStatus();
		res.write(`event: status\ndata: ${JSON.stringify(data)}\n\n`);
	}, 5000);

	const init = {};
	if (app.locals.botManager) {
		init.botStatus = app.locals.botManager.status;
		init.bots = app.locals.botManager.getDetailedBotList();
	}
	res.write(`event: init\ndata: ${JSON.stringify(init)}\n\n`);

	req.on('close', () => {
		adminSSEClients.delete(res);
		clearInterval(heartbeat);
	});
});

function broadcastToAdmins(event, data) {
	const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	for (const client of adminSSEClients) {
		try { client.write(msg); } catch {}
	}
}

function setupBotManagerSSE() {
	if (!app.locals.botManager) return;
	app.locals.botManager.on('statusUpdate', (status) => {
		broadcastToAdmins('botStatusUpdate', status);
	});
}

app.locals.setupBotManagerSSE = setupBotManagerSSE;

app.get('/api/status', (req, res) => {
	if (!app.locals.botManager) {
		return res.json({ online: false, botsReady: 0 });
	}

	const { getSetting } = require('./database');
	const maintenance = getSetting('maintenance', 'false') === 'true';

	res.json({
		online: !maintenance,
		maintenance
	});
});

let _healthCache = null;
let _healthCacheAt = 0;
const HEALTH_CACHE_MS = 30 * 1000;

app.get('/api/system-health', (req, res) => {
	const now = Date.now();
	if (_healthCache && (now - _healthCacheAt) < HEALTH_CACHE_MS) {
		return res.json(_healthCache);
	}

	try {
		const { getSetting } = require('./database');
		const db = require('./database');
		const maintenance = getSetting('maintenance', 'false') === 'true';

		let proxiesOk = true;
		let proxyCount = 0;
		try {
			const proxiesData = require('./proxies.json');
			proxyCount = (proxiesData && proxiesData.proxies && proxiesData.proxies.length) || 0;
		} catch { proxiesOk = false; }

		let botsOk = true;
		let botsLow = false;
		let botPoolSize = 0;
		let problematicCount = 0;
		try {
			if (app.locals.botManager) {
				botPoolSize = app.locals.botManager.getAccounts().length || 0;
				const h = app.locals.botManager.getBotPoolHealth ? app.locals.botManager.getBotPoolHealth() : { problematic: [] };
				problematicCount = (h && h.problematic && h.problematic.length) || 0;
				if (botPoolSize > 0 && problematicCount > botPoolSize * 0.30) botsLow = true;
				if (botPoolSize < 50) botsOk = false;
			} else {
				botsOk = false;
			}
		} catch { botsOk = false; }

		let successRate = null;
		let activeOrders = 0;
		let pendingOrders = 0;
		try {
			const recent = db._db.prepare(
				"SELECT status, COUNT(*) c FROM transactions WHERE created_at > strftime('%s','now')-3600 GROUP BY status"
			).all();
			let completed = 0, partial = 0, failed = 0, processing = 0, pending = 0;
			for (const r of recent) {
				if (r.status === 'completed') completed = r.c;
				else if (r.status === 'partial') partial = r.c;
				else if (r.status === 'failed') failed = r.c;
				else if (r.status === 'processing') processing = r.c;
				else if (r.status === 'pending') pending = r.c;
			}
			const totalFinished = completed + partial + failed;
			if (totalFinished > 0) {
				successRate = Math.round(((completed + partial * 0.6) / totalFinished) * 100);
			}
			activeOrders = processing;
			pendingOrders = pending;
		} catch {}

		let rconOk = true;
		try {
			if (app.locals.serverUpdateMonitor && typeof app.locals.serverUpdateMonitor.lastRconOk === 'function') {
				rconOk = !!app.locals.serverUpdateMonitor.lastRconOk();
			}
		} catch {}

		let overall = 'ok';
		if (maintenance) overall = 'maintenance';
		else if (!botsOk || !rconOk) overall = 'offline';
		else if (botsLow || (successRate !== null && successRate < 70)) overall = 'degraded';

		_healthCache = {
			overall,
			subsystems: {
				proxies: proxiesOk ? 'ok' : 'fail',
				bots:    botsLow ? 'low' : (botsOk ? 'ok' : 'fail'),
				rcon:    rconOk ? 'ok' : 'fail',
				server:  rconOk ? 'ok' : 'fail'
			},
			metrics: {
				botPoolSize,
				proxyCount,
				problematicBots: problematicCount,
				activeOrders,
				pendingOrders,
				successRate1h: successRate
			},
			lastCheck: new Date().toISOString()
		};
		_healthCacheAt = now;
		res.json(_healthCache);
	} catch (e) {
		res.json({
			overall: 'offline',
			subsystems: { proxies: 'fail', bots: 'fail', rcon: 'fail', server: 'fail' },
			metrics: {},
			lastCheck: new Date().toISOString(),
			error: 'health_snapshot_failed'
		});
	}
});

app.get('/api/processor/status', verifyAdmin, (req, res) => {
	if (!app.locals.transactionProcessor) {
		return res.json({ available: false });
	}

	res.json({
		available: true,
		...app.locals.transactionProcessor.getStatus()
	});
});

app.get('/api/steam/profile/:id', verifyUser, async (req, res) => {
	const steamid = req.params.id;

	if (!/^7656\d{13}$/.test(steamid)) {
		return res.status(400).json({ error: 'Invalid SteamID64 format' });
	}

	const apiKey = app.locals.steamApiKey;
	if (!apiKey) {
		return res.status(503).json({ error: 'Steam API key not configured' });
	}

	const cached = getCachedProfile(steamid);
	if (cached) {
		return res.json(cached);
	}

	try {
		const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(apiKey)}&steamids=${steamid}`;

		let http;
		try {
			http = require('node:https');
		} catch {
			http = require('https');
		}

		const data = await new Promise((resolve, reject) => {
			const request = http.get(url, (response) => {
				let body = '';
				response.on('data', chunk => body += chunk);
				response.on('end', () => {
					try {
						resolve(JSON.parse(body));
					} catch (e) {
						reject(new Error('Invalid response from Steam API'));
					}
				});
			});
			request.on('error', reject);
			request.setTimeout(10000, () => {
				request.destroy();
				reject(new Error('Steam API request timed out'));
			});
		});

		if (!data.response || !data.response.players || data.response.players.length === 0) {
			return res.status(404).json({ error: 'Steam profile not found' });
		}

		const player = data.response.players[0];
		const profile = {
			steamid: player.steamid,
			personaname: player.personaname,
			avatarfull: player.avatarfull,
			profileurl: player.profileurl,
			lastlogoff: player.lastlogoff,
			profilestate: player.profilestate
		};

		setCachedProfile(steamid, profile);
		res.json(profile);
	} catch (err) {
		const { logEvent } = require('./middleware/auth');
		logEvent('error', `Steam API error: ${err.message}`, { steamid });
		res.status(503).json({ error: 'Steam API unavailable' });
	}
});

app.get('/api/steam/resolve/:vanity', verifyUser, async (req, res) => {
	const vanity = req.params.vanity;

	if (!/^[a-zA-Z0-9_-]{2,32}$/.test(vanity)) {
		return res.status(400).json({ error: 'Invalid vanity URL format' });
	}

	const apiKey = app.locals.steamApiKey;
	if (!apiKey) {
		return res.status(503).json({ error: 'Steam API key not configured' });
	}

	try {
		const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(apiKey)}&vanityurl=${encodeURIComponent(vanity)}`;

		let http;
		try {
			http = require('node:https');
		} catch {
			http = require('https');
		}

		const data = await new Promise((resolve, reject) => {
			const request = http.get(url, (response) => {
				let body = '';
				response.on('data', chunk => body += chunk);
				response.on('end', () => {
					try {
						resolve(JSON.parse(body));
					} catch (e) {
						reject(new Error('Invalid response from Steam API'));
					}
				});
			});
			request.on('error', reject);
			request.setTimeout(10000, () => {
				request.destroy();
				reject(new Error('Steam API request timed out'));
			});
		});

		if (!data.response || data.response.success !== 1) {
			return res.status(404).json({ error: 'Vanity URL not found' });
		}

		res.json({ steamid: data.response.steamid });
	} catch (err) {
		const { logEvent } = require('./middleware/auth');
		logEvent('error', `Steam Vanity API error: ${err.message}`, { vanity });
		res.status(503).json({ error: 'Steam API unavailable' });
	}
});

app.get('/api/admin/system', verifyAdmin, (req, res) => {
	const memUsage = process.memoryUsage();

	const botStatus = app.locals.botManager
		? { available: true, ...app.locals.botManager.status }
		: { available: false };

	const processorStatus = app.locals.transactionProcessor
		? { available: true, ...app.locals.transactionProcessor.getStatus() }
		: { available: false };

	res.json({
		uptime: process.uptime(),
		memory: {
			rss: memUsage.rss,
			heapUsed: memUsage.heapUsed,
			heapTotal: memUsage.heapTotal,
			external: memUsage.external
		},
		nodeVersion: process.version,
		activeSSEConnections,
		botStatus,
		processorStatus
	});
});

const localizer = require('./lib/localizer');
localizer.loadAllLangs(path.join(__dirname, 'public'));

const SUPPORTED_LANGS = localizer.LANGS.filter(l => l !== 'tr');

function serveLocalizedHtml(res, filePath, lang, requestPath) {
	const html = applyServerTokens(localizer.renderLocalized(filePath, lang, requestPath));
	if (!html) {
		return res.sendFile(filePath);
	}
	res.set('Content-Type', 'text/html; charset=utf-8');
	res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
	res.send(html);
}

app.get('*', (req, res) => {
	if (req.path.startsWith('/api/')) {
		return res.status(404).json({ error: 'Not found' });
	}

	const publicDir = path.join(__dirname, 'public');
	const pages = [
		'dashboard', 'admin', 'login',
		'free-commend', 'hours-boost', 'group-boost',
		'reseller', 'reseller-login', 'bayilik',
		'trust-factor',
		'hakkimizda', 'gizlilik', 'kullanim-kosullari', 'blog',
		'kripto', 'odeme-sonuc', 'odeme-iptal'
	];

	let lang = 'tr';
	let logicalPath = req.path;
	const langMatch = req.path.match(/^\/(en|de|ru|pl|pt|es|fr)(\/.*)?$/i);
	if (langMatch) {
		lang = langMatch[1].toLowerCase();
		logicalPath = langMatch[2] || '/';
	}

	const page = logicalPath.replace(/^\//, '').replace(/\/$/, '');

	if (page === '' || logicalPath === '/') {
		const indexPath = path.resolve(publicDir, 'index.html');
		if (indexPath.startsWith(publicDir)) {
			return serveLocalizedHtml(res, indexPath, lang, '/');
		}
	}

	if (pages.includes(page) && /^[a-zA-Z0-9-]+$/.test(page)) {
		const filePath = path.resolve(publicDir, page + '.html');
		if (filePath.startsWith(publicDir) && require('fs').existsSync(filePath)) {
			return serveLocalizedHtml(res, filePath, lang, '/' + page);
		}
	}

	const blogMatch = logicalPath.match(/^\/blog\/([a-z0-9-]+)\/?$/i);
	if (blogMatch) {
		const slug = blogMatch[1];
		if (/^[a-zA-Z0-9-]+$/.test(slug)) {
			const blogPath = path.resolve(publicDir, 'blog', slug + '.html');
			if (blogPath.startsWith(path.resolve(publicDir, 'blog')) && require('fs').existsSync(blogPath)) {
				return serveLocalizedHtml(res, blogPath, lang, '/blog/' + slug);
			}
		}
	}

	const notFoundPath = path.resolve(publicDir, '404.html');
	if (notFoundPath.startsWith(publicDir) && require('fs').existsSync(notFoundPath)) {
		res.status(404);
		return serveLocalizedHtml(res, notFoundPath, lang, req.path);
	}

	const indexPath = path.resolve(publicDir, 'index.html');
	if (indexPath.startsWith(publicDir)) {
		return serveLocalizedHtml(res, indexPath, lang, '/');
	}

	res.status(403).json({ error: 'Forbidden' });
});

app.use((err, req, res, _next) => {
	const { logEvent } = require('./middleware/auth');
	logEvent('error', `Unhandled error: ${err.message}`, {
		stack: err.stack,
		method: req.method,
		path: req.originalUrl,
		ip: req.ip
	});

	const isDev = process.env.NODE_ENV !== 'production';
	res.status(err.status || 500).json({
		error: isDev ? err.message : 'Internal server error'
	});
});

function startWebServer(options = {}) {
	const port = options.port || config.port || 3000;

	if (options.botManager) {
		app.locals.botManager = options.botManager;
	}

	if (options.transactionProcessor) {
		app.locals.transactionProcessor = options.transactionProcessor;
	}

	if (options.hoursManager) {
		app.locals.hoursManager = options.hoursManager;
	}

	if (options.groupManager) {
		app.locals.groupManager = options.groupManager;
	}

	if (options.gamesatis) {
		app.locals.gamesatis = options.gamesatis;
	}

	if (options.hesap) {
		app.locals.hesap = options.hesap;
	}

	return new Promise((resolve) => {
		const server = app.listen(port, () => {
			console.log(`\x1b[32m[WEB]\x1b[0m CS Commends panel running on http://localhost:${port}`);
			console.log(`\x1b[32m[WEB]\x1b[0m Admin panel: http://localhost:${port}/admin`);
			console.log(`\x1b[32m[WEB]\x1b[0m Production: https://cscommends.com`);
			resolve(server);
		});
	});
}

if (require.main === module) {
	startWebServer();
}

module.exports = { app, startWebServer };
