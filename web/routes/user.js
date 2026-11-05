const express = require('express');
const https = require('https');
const db = require('../database');
const config = require('../config.json');
const { verifyUser, strictRateLimit } = require('../middleware/auth');
const { blockIfMaintenance } = require('../middleware/maintenance');
const { scrapeVanityFromCommunity } = require('../lib/steam-ids');

const router = express.Router();

function validateSteamId(input) {
	if (!input || typeof input !== 'string') {
		return { valid: false, error: 'Steam profile URL or ID is required' };
	}

	const trimmed = input.trim();

	if (trimmed.length === 0 || trimmed.length > 200) {
		return { valid: false, error: 'Invalid Steam ID length' };
	}

	if (/^7656119\d{10}$/.test(trimmed)) {
		return { valid: true, value: trimmed };
	}

	if (/^STEAM_[0-5]:[01]:\d{1,15}$/i.test(trimmed)) {
		return { valid: true, value: trimmed.toUpperCase() };
	}

	if (/^\[U:1:\d{1,15}\]$/.test(trimmed)) {
		return { valid: true, value: trimmed };
	}

	const profileUrlMatch = trimmed.match(
		/^https?:\/\/steamcommunity\.com\/(profiles\/(\d{17})|id\/([a-zA-Z0-9_-]+))\/?$/
	);
	if (profileUrlMatch) {
		return { valid: true, value: trimmed };
	}

	if (/^[a-zA-Z0-9_-]{2,32}$/.test(trimmed)) {
		return { valid: true, value: trimmed };
	}

	return { valid: false, error: 'Invalid Steam profile URL or ID. Supported formats: SteamID64, STEAM_0:1:xxx, [U:1:xxx], profile URL, or vanity name' };
}

async function resolveVanityURL(vanityName, apiKey) {
	if (apiKey) {
		const viaApi = await new Promise((resolve) => {
			const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${apiKey}&vanityurl=${encodeURIComponent(vanityName)}`;
			const req = https.get(url, { timeout: 8000 }, (res) => {
				let data = '';
				res.on('data', chunk => { data += chunk; });
				res.on('end', () => {
					try {
						const json = JSON.parse(data);
						if (json.response && json.response.success === 1 && json.response.steamid) {
							resolve(json.response.steamid);
						} else { resolve(null); }
					} catch { resolve(null); }
				});
			});
			req.on('error', () => resolve(null));
			req.on('timeout', () => { req.destroy(); resolve(null); });
		});
		if (viaApi) return viaApi;
	}
	return scrapeVanityFromCommunity(vanityName);
}

async function resolveSteamIdToId64(input, apiKey) {
	if (!input || typeof input !== 'string') return null;
	const trimmed = input.trim();

	if (/^7656119\d{10}$/.test(trimmed)) return trimmed;

	const profileMatch = trimmed.match(/steamcommunity\.com\/profiles\/(\d{17})/);
	if (profileMatch) return profileMatch[1];

	if (/^STEAM_[0-5]:[01]:\d+$/i.test(trimmed)) {
		try {
			const SteamID = require('steamid');
			return new SteamID(trimmed).getSteamID64();
		} catch { return null; }
	}

	if (/^\[U:1:\d+\]$/.test(trimmed)) {
		try {
			const SteamID = require('steamid');
			return new SteamID(trimmed).getSteamID64();
		} catch { return null; }
	}

	const vanityMatch = trimmed.match(/steamcommunity\.com\/id\/([a-zA-Z0-9_-]+)/);
	if (vanityMatch) {
		return await resolveVanityURL(vanityMatch[1], apiKey);
	}

	if (/^[a-zA-Z0-9_-]{2,32}$/.test(trimmed)) {
		return await resolveVanityURL(trimmed, apiKey);
	}

	return null;
}

const commendTimestamps = new Map();

setInterval(() => {
	const now = Date.now();
	for (const [key, timestamps] of commendTimestamps.entries()) {
		const recent = timestamps.filter(t => now - t < 120000);
		if (recent.length === 0) {
			commendTimestamps.delete(key);
		} else {
			commendTimestamps.set(key, recent);
		}
	}
}, 5 * 60 * 1000);

function checkCommendRateLimit(userId) {
	const now = Date.now();
	const windowMs = 60000;
	const maxPerMinute = 3;

	if (!commendTimestamps.has(userId)) {
		commendTimestamps.set(userId, [now]);
		return { allowed: true };
	}

	const timestamps = commendTimestamps.get(userId).filter(t => now - t < windowMs);
	if (timestamps.length >= maxPerMinute) {
		const oldestInWindow = timestamps[0];
		const retryAfter = Math.ceil((oldestInWindow + windowMs - now) / 1000);
		return { allowed: false, retryAfter };
	}

	timestamps.push(now);
	commendTimestamps.set(userId, timestamps);
	return { allowed: true };
}

router.post('/profile', verifyUser, async (req, res) => {
	try {
		const { steamId, steamName } = req.body;

		const validation = validateSteamId(steamId);
		if (!validation.valid) {
			return res.status(400).json({ error: validation.error });
		}

		const apiKey = req.app.locals.steamApiKey;
		const steamId64 = await resolveSteamIdToId64(validation.value, apiKey);
		if (!steamId64) {
			return res.status(400).json({ error: 'Steam profili bulunamadı. Geçerli bir Steam profil URL\'si veya SteamID64 girin.' });
		}

		const cleanName = steamName
			? String(steamName).trim().slice(0, 64)
			: null;

		db.prepare('UPDATE users SET steam_id = ?, steam_name = ? WHERE id = ?')
			.run(steamId64, cleanName, req.user.userId);

		res.json({ success: true });
	} catch (err) {
		console.error('[user] Profile update error:', err);
		if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
	}
});

router.post('/commend', verifyUser, blockIfMaintenance, async (req, res) => {
  try {
	let { steamId, amount, friendly, teaching, leader } = req.body;

	if (friendly === undefined) friendly = true;
	if (teaching === undefined) teaching = true;
	if (leader === undefined) leader = true;

	const validation = validateSteamId(steamId);
	if (!validation.valid) {
		return res.status(400).json({ error: validation.error });
	}

	const apiKey = req.app.locals.steamApiKey;
	const cleanSteamId = await resolveSteamIdToId64(validation.value, apiKey);
	if (!cleanSteamId) {
		return res.status(400).json({ error: 'Steam profili bulunamadı. Geçerli bir Steam profil URL\'si veya SteamID64 girin.' });
	}

	amount = parseInt(amount);
	if (!amount || amount <= 0 || amount > 10000) {
		return res.status(400).json({ error: 'Invalid commend amount (1-10000)' });
	}

	if (!friendly && !teaching && !leader) {
		return res.status(400).json({ error: 'At least one commend type must be selected' });
	}

	const rateCheck = checkCommendRateLimit(req.user.userId);
	if (!rateCheck.allowed) {
		return res.status(429).json({
			error: 'Too many commend requests. Please wait before creating another.',
			retryAfterSeconds: rateCheck.retryAfter
		});
	}

	const createCommendTx = db.transaction(() => {
		const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId);
		if (!user) {
			return { error: 'User not found', status: 404 };
		}

		if (user.balance < amount) {
			return {
				error: `Insufficient balance. You have ${user.balance} commends remaining`,
				status: 400
			};
		}

		const active = db.prepare(
			"SELECT COUNT(*) as count FROM transactions WHERE user_id = ? AND status IN ('pending', 'processing')"
		).get(req.user.userId);

		if (active.count > 0) {
			return {
				error: 'You already have an active transaction. Please wait for it to finish.',
				status: 400
			};
		}

		db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amount, req.user.userId);

		const result = db.prepare(
			'INSERT INTO transactions (user_id, steam_id, friendly, teaching, leader, total, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
		).run(
			req.user.userId, cleanSteamId,
			friendly ? amount : 0, teaching ? amount : 0, leader ? amount : 0,
			amount, 'pending'
		);

		const transaction = db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid);
		const updatedUser = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.userId);

		return {
			success: true,
			transaction,
			newBalance: updatedUser.balance
		};
	});

	const result = createCommendTx();

	if (result.error) {
		return res.status(result.status).json({ error: result.error });
	}

	res.json({
		transaction: formatTransaction(result.transaction),
		newBalance: result.newBalance
	});
  } catch (err) {
	console.error('[user] Commend error:', err);
	if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/transactions/active', verifyUser, (req, res) => {
	const transactions = db.prepare(
		"SELECT * FROM transactions WHERE user_id = ? AND status IN ('pending', 'processing') ORDER BY created_at DESC"
	).all(req.user.userId);

	res.json(transactions.map(formatTransaction));
});

router.get('/transactions/history', verifyUser, (req, res) => {
	const page = parseInt(req.query.page) || 1;
	const limit = Math.min(parseInt(req.query.limit) || 10, 50);
	const offset = (page - 1) * limit;

	const transactions = db.prepare(
		'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
	).all(req.user.userId, limit, offset);

	const total = db.prepare(
		'SELECT COUNT(*) as count FROM transactions WHERE user_id = ?'
	).get(req.user.userId);

	res.json({
		transactions: transactions.map(formatTransaction),
		total: total.count,
		page,
		totalPages: Math.ceil(total.count / limit)
	});
});

router.post('/transactions/:id/cancel', verifyUser, (req, res) => {
	return res.status(403).json({ error: 'İşlem iptali devre dışı bırakılmıştır. Lütfen yöneticiyle iletişime geçin.' });
});

router.post('/promo/redeem', verifyUser, strictRateLimit, (req, res) => {
	const { code } = req.body;
	if (!code || typeof code !== 'string') {
		return res.status(400).json({ error: 'Promosyon kodu gerekli' });
	}

	const cleanCode = code.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');

	const redeemTx = db.transaction(() => {
		const promo = db.prepare('SELECT * FROM promo_codes WHERE code = ?').get(cleanCode);
		if (!promo) return { error: 'Geçersiz promosyon kodu', status: 404 };
		if (!promo.is_active) return { error: 'Bu promosyon kodu artık aktif değil', status: 400 };
		if (promo.current_uses >= promo.max_uses) return { error: 'Bu promosyon kodu kullanım limitine ulaştı', status: 400 };
		if (promo.expires_at && new Date(promo.expires_at) < new Date()) return { error: 'Bu promosyon kodunun süresi dolmuş', status: 400 };

		const existing = db.prepare(
			'SELECT * FROM promo_redemptions WHERE promo_id = ? AND user_id = ?'
		).get(promo.id, req.user.userId);
		if (existing) return { error: 'Bu promosyon kodunu zaten kullandınız', status: 400 };

		db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(promo.balance, req.user.userId);
		db.prepare('UPDATE promo_codes SET current_uses = current_uses + 1 WHERE id = ?').run(promo.id);
		db.prepare(
			'INSERT INTO promo_redemptions (promo_id, user_id, balance_given) VALUES (?, ?, ?)'
		).run(promo.id, req.user.userId, promo.balance);

		const updatedUser = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.userId);

		return {
			success: true,
			balanceAdded: promo.balance,
			newBalance: updatedUser.balance,
			communityName: promo.community_name
		};
	});

	const result = redeemTx();
	if (result.error) return res.status(result.status).json({ error: result.error });
	res.json(result);
});

router.get('/servers', verifyUser, (req, res) => {
	res.json(config.serverInfo || []);
});

function _estimateRemainingSec(total, progress) {
	const remaining = Math.max(0, (total || 0) - (progress || 0));
	if (remaining === 0) return 0;
	const baseSec = (remaining / 16) * 60;
	return Math.ceil(baseSec * 1.25);
}

const _CANCEL_REASON_MAP = {
	'target_error': 'Hedef oyuncu sunucudan ayrıldı',
	'bot_error':    'Bot havuzunda geçici sorun',
	'network_error': 'Ağ bağlantısı sorunu (Steam/sunucu)',
	'rate_limit':   'Steam tarafından geçici hız kısıtı',
	'unknown':      'Bilinmeyen sistem hatası',
	'maintenance':  'Sistem bakımdaydı, işlem durduruldu',
};

function _humanReason(errorType, errorMessage) {
	if (errorMessage && /[ğüşıöçĞÜŞİÖÇ]/.test(errorMessage)) return errorMessage;
	if (errorType && _CANCEL_REASON_MAP[errorType]) return _CANCEL_REASON_MAP[errorType];
	return errorMessage || errorType || null;
}

function formatTransaction(t) {
	const isActive = t.status === 'pending' || t.status === 'processing' || t.status === 'resuming';
	const isFailedOrCancelled = t.status === 'failed' || t.status === 'cancelled' || t.status === 'partial';
	const refundedAmount = isFailedOrCancelled ? Math.max(0, (t.total || 0) - (t.progress || 0)) : 0;

	return {
		id: t.id,
		steamId: t.steam_id,
		friendly: t.friendly,
		teaching: t.teaching,
		leader: t.leader,
		total: t.total,
		progress: t.progress,
		status: t.status,
		createdAt: t.created_at,
		completedAt: t.completed_at,
		errorType: t.error_type || null,
		errorMessage: t.error_message || null,
		failReason: isFailedOrCancelled ? _humanReason(t.error_type, t.error_message) : null,
		refundedAmount: refundedAmount,
		estimatedRemainingSec: isActive ? _estimateRemainingSec(t.total, t.progress) : null
	};
}

module.exports = router;
