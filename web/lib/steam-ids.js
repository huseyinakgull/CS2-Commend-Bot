const https = require('https');
const SteamID = require('steamid');

function parseSteamId64(input) {
	if (!input || typeof input !== 'string') return null;
	const trimmed = input.trim();

	if (/^7656119\d{10}$/.test(trimmed)) return trimmed;

	const profMatch = trimmed.match(/steamcommunity\.com\/profiles\/(\d{17})/);
	if (profMatch) return profMatch[1];

	if (/^STEAM_[0-5]:[01]:\d+$/i.test(trimmed)) {
		try { return new SteamID(trimmed).getSteamID64(); } catch { return null; }
	}

	if (/^\[U:1:\d+\]$/.test(trimmed)) {
		try { return new SteamID(trimmed).getSteamID64(); } catch { return null; }
	}

	return null;
}

function extractVanityUser(input) {
	if (!input || typeof input !== 'string') return null;
	const m = input.trim().match(/steamcommunity\.com\/id\/([a-zA-Z0-9_-]+)/);
	return m ? m[1] : null;
}

function scrapeVanityFromCommunity(vanityName) {
	return new Promise((resolve) => {
		if (!vanityName || typeof vanityName !== 'string') return resolve(null);
		const clean = vanityName.trim().replace(/[^a-zA-Z0-9_-]/g, '');
		if (!clean || clean.length < 2 || clean.length > 64) return resolve(null);

		const req = https.get({
			hostname: 'steamcommunity.com',
			path: '/id/' + encodeURIComponent(clean) + '/',
			method: 'GET',
			timeout: 10000,
			headers: {
				'User-Agent': 'cs-commends/1.0 (+https://cscommends.com)',
				'Accept': 'text/html'
			}
		}, (res) => {
			if (res.statusCode !== 200) { res.resume(); return resolve(null); }
			let data = '';
			let bytes = 0;
			res.on('data', (c) => {
				bytes += c.length;
				if (bytes > 500000) { req.destroy(); return; }
				data += c;
			});
			res.on('end', () => {
				const m1 = data.match(/g_rgProfileData\s*=\s*\{[^}]*"steamid"\s*:\s*"(\d{17})"/);
				if (m1) return resolve(m1[1]);
				const m2 = data.match(/"steamid":"(\d{17})"/);
				if (m2) return resolve(m2[1]);
				resolve(null);
			});
		});
		req.on('error', () => resolve(null));
		req.on('timeout', () => { req.destroy(); resolve(null); });
	});
}

async function resolveVanityUser(vanityName, apiKey) {
	if (apiKey) {
		const viaApi = await new Promise((resolve) => {
			const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${apiKey}&vanityurl=${encodeURIComponent(vanityName)}`;
			const req = https.get(url, { timeout: 8000 }, (res) => {
				let data = '';
				res.on('data', (c) => { data += c; });
				res.on('end', () => {
					try {
						const json = JSON.parse(data);
						if (json.response && json.response.success === 1 && json.response.steamid) {
							resolve(json.response.steamid);
						} else resolve(null);
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

async function parseSteamId(input, apiKey) {
	const direct = parseSteamId64(input);
	if (direct) return direct;
	const vanity = extractVanityUser(input);
	if (vanity && apiKey) {
		const resolved = await resolveVanityUser(vanity, apiKey);
		if (resolved) return resolved;
	}
	return null;
}

function parseGroupInput(input) {
	if (!input || typeof input !== 'string') return { vanity: null, id64: null };
	const trimmed = input.trim();

	if (/^\d{17,18}$/.test(trimmed)) {
		return { vanity: null, id64: trimmed };
	}

	const gidMatch = trimmed.match(/steamcommunity\.com\/gid\/(\d{17,18})/i);
	if (gidMatch) return { vanity: null, id64: gidMatch[1] };

	const grpMatch = trimmed.match(/steamcommunity\.com\/groups\/([a-zA-Z0-9_-]+)/i);
	if (grpMatch) return { vanity: grpMatch[1], id64: null };

	if (/^[a-zA-Z0-9_-]{2,64}$/.test(trimmed)) {
		return { vanity: trimmed, id64: null };
	}

	return { vanity: null, id64: null };
}

function fetchGroupMeta({ vanity, id64 }) {
	return new Promise((resolve) => {
		const hostPath = vanity
			? `/groups/${encodeURIComponent(vanity)}/memberslistxml/?xml=1`
			: `/gid/${encodeURIComponent(id64)}/memberslistxml/?xml=1`;
		const req = https.get({
			hostname: 'steamcommunity.com',
			path: hostPath,
			method: 'GET',
			timeout: 10000,
			headers: { 'User-Agent': 'cs-commends/1.0' }
		}, (res) => {
			if (res.statusCode !== 200) {
				res.resume();
				return resolve(null);
			}
			let data = '';
			res.on('data', (c) => { data += c; });
			res.on('end', () => {
				if (!/<groupID64>/i.test(data)) return resolve(null);

				const idMatch      = data.match(/<groupID64>(\d+)<\/groupID64>/i);
				const nameMatch    = data.match(/<groupName>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/groupName>/i)
				                  || data.match(/<groupName>\s*([\s\S]*?)\s*<\/groupName>/i);
				const avatarMatch  = data.match(/<avatarMedium>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/avatarMedium>/i)
				                  || data.match(/<avatarMedium>\s*([\s\S]*?)\s*<\/avatarMedium>/i);
				const urlMatch     = data.match(/<groupURL>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/groupURL>/i)
				                  || data.match(/<groupURL>\s*([\s\S]*?)\s*<\/groupURL>/i);
				const membersMatch = data.match(/<memberCount>(\d+)<\/memberCount>/i);

				if (!idMatch) return resolve(null);
				resolve({
					id64:        idMatch[1],
					name:        nameMatch ? nameMatch[1].trim() : null,
					vanity:      urlMatch ? urlMatch[1].trim() : (vanity || null),
					avatar:      avatarMatch ? avatarMatch[1].trim() : null,
					memberCount: membersMatch ? parseInt(membersMatch[1], 10) : null
				});
			});
		});
		req.on('error', () => resolve(null));
		req.on('timeout', () => { req.destroy(); resolve(null); });
	});
}

async function resolveGroup(input) {
	const parsed = parseGroupInput(input);
	if (!parsed.vanity && !parsed.id64) return null;
	return fetchGroupMeta(parsed);
}

module.exports = {
	parseSteamId64,
	parseSteamId,
	extractVanityUser,
	resolveVanityUser,
	scrapeVanityFromCommunity,
	parseGroupInput,
	fetchGroupMeta,
	resolveGroup
};
