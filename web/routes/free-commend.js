const express = require('express');
const https = require('https');
const SteamID = require('steamid');
const db = require('../database');
const { rateLimit } = require('../middleware/auth');
const { blockIfMaintenance } = require('../middleware/maintenance');
const discordRoute = require('./discord');
const { scrapeVanityFromCommunity } = require('../lib/steam-ids');
const config = require('../config.json');

const router = express.Router();

const freeCommendTimestamps = new Map();

setInterval(() => {
	const now = Date.now();
	for (const [key, timestamps] of freeCommendTimestamps.entries()) {
		const recent = timestamps.filter(t => now - t < 120000);
		if (recent.length === 0) freeCommendTimestamps.delete(key);
		else freeCommendTimestamps.set(key, recent);
	}
}, 5 * 60 * 1000);

function checkFreeRateLimit(ip) {
	const now = Date.now();
	const windowMs = 60000;
	const maxPerMinute = 3;

	if (!freeCommendTimestamps.has(ip)) {
		freeCommendTimestamps.set(ip, [now]);
		return { allowed: true };
	}

	const timestamps = freeCommendTimestamps.get(ip).filter(t => now - t < windowMs);
	if (timestamps.length >= maxPerMinute) {
		const retryAfter = Math.ceil((timestamps[0] + windowMs - now) / 1000);
		return { allowed: false, retryAfter };
	}

	timestamps.push(now);
	freeCommendTimestamps.set(ip, timestamps);
	return { allowed: true };
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
						} else {
							resolve(null);
						}
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

function parseSteamIdSync(input) {
	if (!input || typeof input !== 'string') return null;
	const trimmed = input.trim();

	if (/^7656119\d{10}$/.test(trimmed)) return trimmed;

	const profileMatch = trimmed.match(/steamcommunity\.com\/profiles\/(\d{17})/);
	if (profileMatch) return profileMatch[1];

	if (/^STEAM_[0-5]:[01]:\d+$/i.test(trimmed)) {
		try {
			const sid = new SteamID(trimmed);
			return sid.getSteamID64();
		} catch { return null; }
	}

	if (/^\[U:1:\d+\]$/.test(trimmed)) {
		try {
			const sid = new SteamID(trimmed);
			return sid.getSteamID64();
		} catch { return null; }
	}

	return null;
}

function extractVanityName(input) {
	if (!input || typeof input !== 'string') return null;
	const trimmed = input.trim();

	const vanityMatch = trimmed.match(/steamcommunity\.com\/id\/([a-zA-Z0-9_-]+)/);
	if (vanityMatch) return vanityMatch[1];

	return null;
}

async function parseSteamId(input, apiKey) {
	const syncResult = parseSteamIdSync(input);
	if (syncResult) return syncResult;

	const vanityName = extractVanityName(input);
	if (vanityName && apiKey) {
		const resolved = await resolveVanityURL(vanityName, apiKey);
		if (resolved) return resolved;
	}

	return null;
}

router.get('/status/:steamId', (req, res) => {
	const steamId64 = parseSteamIdSync(req.params.steamId);
	if (!steamId64) return res.status(400).json({ error: 'invalid_steam_id' });

	const row = db.prepare('SELECT * FROM free_commends WHERE steam_id = ?').get(steamId64);
	if (!row) return res.json({ used: false });

	let progress = row.progress;
	let status = row.status;
	let completedAt = row.completed_at;

	if (row.transaction_id) {
		const tx = db.prepare('SELECT progress, status, completed_at FROM transactions WHERE id = ?').get(row.transaction_id);
		if (tx) {
			progress = tx.progress;
			status = tx.status;
			completedAt = tx.completed_at;
			if (tx.progress !== row.progress || tx.status !== row.status) {
				db.prepare('UPDATE free_commends SET progress = ?, status = ?, completed_at = ? WHERE id = ?')
					.run(tx.progress, tx.status, tx.completed_at, row.id);
			}
		}
	}

	res.json({
		used: true,
		id: row.id,
		steamId: steamId64,
		status,
		progress,
		total: row.total,
		createdAt: row.created_at,
		completedAt: completedAt
	});
});

router.post('/start', blockIfMaintenance, async (req, res) => {
  try {
	const { steamId } = req.body;

	const discordCfg = (config && config.discord) || {};
	const requireDiscord = (config.freeCommendRequireDiscord !== false);
	if (requireDiscord) {
		if (!discordCfg.clientId || !discordCfg.clientSecret || !discordCfg.guildId) {
			console.error('[free-commend] Discord config eksik — servis pasif (fail-closed)');
			return res.status(503).json({ error: 'discord_gate_misconfigured' });
		}
		let v = null;
		try { v = discordRoute.isVerified(req); }
		catch (e) {
			console.error('[free-commend] isVerified atım:', e.message);
			return res.status(403).json({
				error: 'discord_verify_failed',
				inviteUrl: discordCfg.inviteUrl || null,
				authUrl: '/api/discord/auth'
			});
		}
		if (!v) {
			return res.status(403).json({
				error: 'discord_required',
				inviteUrl: discordCfg.inviteUrl || null,
				authUrl: '/api/discord/auth'
			});
		}
	}

	const rateCheck = checkFreeRateLimit(req.ip);
	if (!rateCheck.allowed) {
		return res.status(429).json({
			error: 'rate_limited',
			retryAfterSeconds: rateCheck.retryAfter
		});
	}

	const steamApiKey = req.app.locals.steamApiKey;
	const steamId64 = await parseSteamId(steamId, steamApiKey);
	if (!steamId64) {
		return res.status(400).json({ error: 'invalid_steam_id' });
	}

	const existing = db.prepare('SELECT * FROM free_commends WHERE steam_id = ?').get(steamId64);
	if (existing) {
		return res.status(400).json({
			error: 'already_used',
			status: existing.status,
			progress: existing.progress,
			total: existing.total
		});
	}

	const botManager = req.app.locals.botManager;
	if (!botManager) {
		return res.status(503).json({ error: 'service_unavailable' });
	}

	if (botManager.checkPlayerOnServer) {
		try {
			const sid = new SteamID(steamId64);
			const targetAccountId = sid.accountid;
			const isOnServer = await botManager.checkPlayerOnServer(targetAccountId);
			if (isOnServer === false) {
				return res.status(400).json({ error: 'player_not_on_server' });
			}
		} catch (err) {
		}
	}

	const FREE_COUNT = 20;

	let systemUser = db.prepare("SELECT id FROM users WHERE steam_id = '__FREE_SYSTEM__'").get();
	if (!systemUser) {
		db.prepare("INSERT OR IGNORE INTO codes (code, balance, initial_balance, is_used) VALUES ('FREE-SYSTEM-CODE', 0, 0, 1)").run();
		const code = db.prepare("SELECT id FROM codes WHERE code = 'FREE-SYSTEM-CODE'").get();
		db.prepare("INSERT OR IGNORE INTO users (code_id, steam_id, steam_name, balance) VALUES (?, '__FREE_SYSTEM__', 'Free Commend System', 0)").run(code.id);
		systemUser = db.prepare("SELECT id FROM users WHERE steam_id = '__FREE_SYSTEM__'").get();
	}

	const createFreeTx = db.transaction(() => {
		db.prepare('INSERT INTO free_commends (steam_id, ip, total) VALUES (?, ?, ?)').run(steamId64, req.ip, FREE_COUNT);

		const txResult = db.prepare(
			"INSERT INTO transactions (user_id, steam_id, friendly, teaching, leader, total, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')"
		).run(systemUser.id, steamId64, FREE_COUNT, FREE_COUNT, FREE_COUNT, FREE_COUNT);

		db.prepare('UPDATE free_commends SET transaction_id = ? WHERE steam_id = ?').run(txResult.lastInsertRowid, steamId64);

		return txResult.lastInsertRowid;
	});

	const transactionId = createFreeTx();

	res.json({
		success: true,
		transactionId,
		total: FREE_COUNT,
		steamId: steamId64
	});
  } catch (err) {
	console.error('[free-commend] Start error:', err);
	if (!res.headersSent) {
		res.status(500).json({ error: 'internal_error' });
	}
  }
});

module.exports = router;
