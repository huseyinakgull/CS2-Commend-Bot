const express = require('express');
const https = require('https');
const db = require('../database');
const { rateLimit } = require('../middleware/auth');
const { parseSteamId } = require('../lib/steam-ids');
const { computeScore } = require('../lib/trust-factor-scorer');

const router = express.Router();

const APP_CS2 = 730;

const TF_RATE = rateLimit(20, 60_000, 'tf-analyze');
const TF_DEEP_RATE = rateLimit(3, 60_000, 'tf-deep');

function steamApi(path) {
	return new Promise((resolve) => {
		https.get('https://api.steampowered.com' + path, { timeout: 8000 }, (res) => {
			let body = '';
			res.on('data', c => body += c);
			res.on('end', () => {
				try { resolve({ ok: res.statusCode === 200, data: JSON.parse(body) }); }
				catch { resolve({ ok: false, data: null }); }
			});
		}).on('error', () => resolve({ ok: false, data: null }));
	});
}

async function fetchProfileData(steamid64, apiKey) {
	const k = encodeURIComponent(apiKey);
	const sid = encodeURIComponent(steamid64);

	const [summary, ownedGames, level, friends, bans] = await Promise.all([
		steamApi(`/ISteamUser/GetPlayerSummaries/v2/?key=${k}&steamids=${sid}`),
		steamApi(`/IPlayerService/GetOwnedGames/v1/?key=${k}&steamid=${sid}&include_played_free_games=1&include_appinfo=0&format=json`),
		steamApi(`/IPlayerService/GetSteamLevel/v1/?key=${k}&steamid=${sid}`),
		steamApi(`/ISteamUser/GetFriendList/v1/?key=${k}&steamid=${sid}&relationship=friend`),
		steamApi(`/ISteamUser/GetPlayerBans/v1/?key=${k}&steamids=${sid}`)
	]);

	const player = summary.data?.response?.players?.[0] || null;
	if (!player) return null;

	const games = ownedGames.data?.response?.games || [];
	const cs2 = games.find(g => g.appid === APP_CS2);
	const cs2Hours = cs2 ? Math.round(cs2.playtime_forever / 60) : 0;

	const steamLevel = level.data?.response?.player_level ?? null;
	const friendCount = friends.data?.friendslist?.friends?.length ?? null;

	const bansArr = bans.data?.players || [];
	const banData = bansArr[0] || null;

	return {
		steamid64,
		personaname: player.personaname,
		profileurl: player.profileurl,
		avatarmedium: player.avatarmedium,
		avatarfull: player.avatarfull,
		timecreated: player.timecreated,
		lastlogoff: player.lastlogoff,
		personastate: player.personastate,
		communityvisibilitystate: player.communityvisibilitystate,
		profilestate: player.profilestate,
		gameid: player.gameid,
		gameserverip: player.gameserverip,
		gameextrainfo: player.gameextrainfo,
		cs2Hours,
		gameCount: ownedGames.data?.response?.game_count ?? null,
		steamLevel,
		friendCount,
		bans: banData,
		commendData: null
	};
}

try {
	db.exec(`
		CREATE TABLE IF NOT EXISTS trust_factor_checks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			steam_id64 TEXT,
			score REAL,
			tier TEXT,
			deep INTEGER NOT NULL DEFAULT 0,
			ip TEXT,
			user_agent TEXT,
			created_at TEXT DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_tf_created ON trust_factor_checks(created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_tf_steam ON trust_factor_checks(steam_id64);
	`);
} catch {}

function recordCheck(steamid64, score, tier, deep, req) {
	try {
		db.prepare(`
			INSERT INTO trust_factor_checks (steam_id64, score, tier, deep, ip, user_agent)
			VALUES (?, ?, ?, ?, ?, ?)
		`).run(steamid64, score, tier, deep ? 1 : 0,
			req.ip || '',
			(req.headers['user-agent'] || '').slice(0, 200));
	} catch {}
}

router.post('/analyze', TF_RATE, async (req, res) => {
	const { steamInput } = req.body || {};
	if (!steamInput || typeof steamInput !== 'string') {
		return res.status(400).json({ ok: false, error: 'steamInput_required' });
	}

	const apiKey = req.app.locals.steamApiKey;
	if (!apiKey) {
		return res.status(503).json({ ok: false, error: 'steam_api_not_configured' });
	}

	const steamid64 = await parseSteamId(steamInput.trim(), apiKey);
	if (!steamid64) {
		return res.status(400).json({ ok: false, error: 'invalid_steam_id', message: 'Geçerli bir Steam ID, SteamID64 veya profil URL gir.' });
	}

	const profile = await fetchProfileData(steamid64, apiKey);
	if (!profile) {
		return res.status(404).json({ ok: false, error: 'profile_not_found' });
	}

	const result = computeScore(profile);
	recordCheck(steamid64, result.score, result.tier.tier, false, req);

	res.json({
		ok: true,
		steamid64,
		profile: {
			personaname: profile.personaname,
			profileurl: profile.profileurl,
			avatarurl: profile.avatarfull || profile.avatarmedium
		},
		...result
	});
});

router.post('/analyze-deep', TF_DEEP_RATE, async (req, res) => {
	const { steamInput } = req.body || {};
	if (!steamInput || typeof steamInput !== 'string') {
		return res.status(400).json({ ok: false, error: 'steamInput_required' });
	}

	const apiKey = req.app.locals.steamApiKey;
	if (!apiKey) return res.status(503).json({ ok: false, error: 'steam_api_not_configured' });

	const steamid64 = await parseSteamId(steamInput.trim(), apiKey);
	if (!steamid64) return res.status(400).json({ ok: false, error: 'invalid_steam_id' });

	const profile = await fetchProfileData(steamid64, apiKey);
	if (!profile) return res.status(404).json({ ok: false, error: 'profile_not_found' });

	const SteamID = require('steamid');
	let accountId;
	try {
		accountId = new SteamID(steamid64).accountid;
	} catch { accountId = null; }

	const manager = req.app.locals.botManager;
	if (manager && typeof manager.getPlayerCommendCount === 'function' && accountId) {
		try {
			const cc = await Promise.race([
				manager.getPlayerCommendCount(accountId),
				new Promise(r => setTimeout(() => r(null), 12000))
			]);
			if (cc && typeof cc === 'object') {
				profile.commendData = {
					friendly: cc.friendly || 0,
					teaching: cc.teaching || 0,
					leader: cc.leader || 0,
					total: (cc.friendly || 0) + (cc.teaching || 0) + (cc.leader || 0)
				};
			}
		} catch {}
	}

	const result = computeScore(profile);
	recordCheck(steamid64, result.score, result.tier.tier, true, req);

	res.json({
		ok: true,
		steamid64,
		profile: {
			personaname: profile.personaname,
			profileurl: profile.profileurl,
			avatarurl: profile.avatarfull || profile.avatarmedium
		},
		...result
	});
});

router.get('/stats', (req, res) => {
	const total = db.prepare('SELECT COUNT(*) as c FROM trust_factor_checks').get().c;
	const last24h = db.prepare(`SELECT COUNT(*) as c FROM trust_factor_checks WHERE created_at >= datetime('now', '-1 day')`).get().c;
	const tierDist = db.prepare(`
		SELECT tier, COUNT(*) as c FROM trust_factor_checks
		WHERE created_at >= datetime('now', '-30 days')
		GROUP BY tier
	`).all();
	res.json({ total, last24h, tierDistribution: tierDist });
});

module.exports = router;
