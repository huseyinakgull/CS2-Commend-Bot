const fetch = global.fetch || require('node-fetch');

const BASE = (process.env.CSCOMMENDS_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
let cachedToken = null;
let cachedTokenExp = 0;

async function getAdminToken() {
	if (cachedToken && Date.now() < cachedTokenExp - 30 * 60 * 1000) {
		return cachedToken;
	}
	const password = process.env.CSCOMMENDS_ADMIN_PASSWORD;
	if (!password) {
		try {
			const cfg = require('../../web/config.json');
			if (cfg.adminPassword) {
				return _loginWith(cfg.adminPassword);
			}
		} catch {}
		throw new Error('CSCOMMENDS_ADMIN_PASSWORD .env\'de tanımlı değil');
	}
	return _loginWith(password);
}

async function _loginWith(password) {
	const r = await fetch(`${BASE}/api/auth/admin`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password })
	});
	if (!r.ok) {
		throw new Error(`Admin login fail (${r.status}): ${await r.text()}`);
	}
	const data = await r.json();
	if (!data.token) throw new Error('Admin login response token yok');
	cachedToken = data.token;
	try {
		const payload = JSON.parse(Buffer.from(data.token.split('.')[1], 'base64').toString());
		cachedTokenExp = (payload.exp || (Math.floor(Date.now() / 1000) + 3600)) * 1000;
	} catch {
		cachedTokenExp = Date.now() + 3600 * 1000;
	}
	return cachedToken;
}

async function generateCode({ balance, productType = 'commend', expiresAt = null }) {
	const token = await getAdminToken();
	const body = {
		count: 1,
		balance,
		productType,
		...(expiresAt ? { expiresAt } : {})
	};
	const r = await fetch(`${BASE}/api/admin/codes/generate`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': 'Bearer ' + token
		},
		body: JSON.stringify(body)
	});
	if (!r.ok) {
		throw new Error(`Code generate fail (${r.status}): ${await r.text()}`);
	}
	const data = await r.json();
	const codes = data.codes || data.generated || [];
	if (codes.length === 0) throw new Error('Generate response codes boş');
	const first = typeof codes[0] === 'string' ? { code: codes[0], balance } : codes[0];
	return { code: first.code, balance: first.balance || balance };
}

module.exports = { getAdminToken, generateCode };
