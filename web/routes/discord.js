const express = require('express');
const https = require('https');
const crypto = require('crypto');
const config = require('../config.json');

const router = express.Router();

const COOKIE_NAME = 'discord_verified';
const STATE_COOKIE = 'discord_oauth_state';
const DEFAULT_TTL = 1800;

function getCfg() {
	return config.discord || {};
}

function getRedirectUri(req) {
	const cfg = getCfg();
	if (cfg.redirectUri) return cfg.redirectUri;
	const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
	const host = req.headers['x-forwarded-host'] || req.headers.host;
	return `${proto}://${host}/api/discord/callback`;
}

function parseCookies(req) {
	const header = req.headers.cookie;
	if (!header) return {};
	const out = {};
	const parts = header.split(';');
	for (const part of parts) {
		const eq = part.indexOf('=');
		if (eq < 0) continue;
		const k = part.slice(0, eq).trim();
		const v = part.slice(eq + 1).trim();
		if (k) out[k] = decodeURIComponent(v);
	}
	return out;
}

function sign(payload, secret) {
	return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function issueVerifiedCookie(res, discordUserId) {
	const cfg = getCfg();
	const secret = cfg.cookieSecret || 'insecure-default-secret';
	const ttl = cfg.verifyTtlSeconds || DEFAULT_TTL;
	const expiry = Math.floor(Date.now() / 1000) + ttl;
	const userIdSafe = String(discordUserId || '').replace(/[^0-9]/g, '');
	const payload = `${expiry}.${userIdSafe}`;
	const sig = sign(payload, secret);
	const value = `${payload}.${sig}`;
	const isHttps = (cfg.redirectUri || '').startsWith('https://');
	const flags = [
		`${COOKIE_NAME}=${encodeURIComponent(value)}`,
		'Path=/',
		`Max-Age=${ttl}`,
		'SameSite=Lax',
		'HttpOnly'
	];
	if (isHttps) flags.push('Secure');
	res.setHeader('Set-Cookie', flags.join('; '));
}

function verifyCookieValue(raw, secret) {
	if (!raw || typeof raw !== 'string') return null;
	const parts = raw.split('.');
	if (parts.length !== 3) return null;
	const [expiryStr, userId, sig] = parts;
	const payload = `${expiryStr}.${userId}`;
	const expected = sign(payload, secret);
	if (sig.length !== expected.length) return null;
	let diff = 0;
	for (let i = 0; i < sig.length; i++) {
		diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
	}
	if (diff !== 0) return null;
	const expiry = parseInt(expiryStr, 10);
	if (!Number.isFinite(expiry)) return null;
	if (expiry < Math.floor(Date.now() / 1000)) return null;
	return { userId, expiry };
}

function isVerified(req) {
	const cfg = getCfg();
	const secret = cfg.cookieSecret || 'insecure-default-secret';
	const cookies = parseCookies(req);
	return verifyCookieValue(cookies[COOKIE_NAME], secret);
}

function requireDiscordVerified(req, res, next) {
	const cfg = getCfg();
	if (!cfg.clientId || !cfg.clientSecret || !cfg.guildId) {
		return next();
	}
	const v = isVerified(req);
	if (!v) {
		return res.status(403).json({
			error: 'discord_required',
			inviteUrl: cfg.inviteUrl || null,
			authUrl: '/api/discord/auth'
		});
	}
	req.discordUserId = v.userId;
	next();
}

function httpsJson(options, bodyStr) {
	return new Promise((resolve, reject) => {
		const req = https.request(options, (res) => {
			let buf = '';
			res.on('data', (c) => { buf += c; });
			res.on('end', () => {
				try {
					resolve({ status: res.statusCode, data: buf ? JSON.parse(buf) : null });
				} catch {
					resolve({ status: res.statusCode, data: null, raw: buf });
				}
			});
		});
		req.on('error', reject);
		req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
		if (bodyStr) req.write(bodyStr);
		req.end();
	});
}

async function exchangeCode(code, redirectUri) {
	const cfg = getCfg();
	const body = new URLSearchParams({
		client_id: cfg.clientId,
		client_secret: cfg.clientSecret,
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUri
	}).toString();

	const { status, data } = await httpsJson({
		hostname: 'discord.com',
		path: '/api/v10/oauth2/token',
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'Content-Length': Buffer.byteLength(body)
		}
	}, body);

	if (status !== 200 || !data || !data.access_token) {
		const err = new Error('token_exchange_failed');
		err.discordStatus = status;
		err.discordData = data;
		throw err;
	}
	return data;
}

async function fetchDiscordUser(accessToken) {
	const { status, data } = await httpsJson({
		hostname: 'discord.com',
		path: '/api/v10/users/@me',
		method: 'GET',
		headers: { Authorization: `Bearer ${accessToken}` }
	});
	if (status !== 200 || !data) throw new Error('users_me_failed');
	return data;
}

async function fetchUserGuilds(accessToken) {
	const { status, data } = await httpsJson({
		hostname: 'discord.com',
		path: '/api/v10/users/@me/guilds',
		method: 'GET',
		headers: { Authorization: `Bearer ${accessToken}` }
	});
	if (status !== 200 || !Array.isArray(data)) throw new Error('guilds_failed');
	return data;
}

router.get('/status', (req, res) => {
	const cfg = getCfg();
	if (!cfg.clientId || !cfg.guildId) {
		return res.json({ enabled: false, verified: false });
	}
	const v = isVerified(req);
	res.json({
		enabled: true,
		verified: !!v,
		expiresAt: v ? v.expiry : null,
		inviteUrl: cfg.inviteUrl || null,
		authUrl: '/api/discord/auth'
	});
});

router.get('/auth', (req, res) => {
	const cfg = getCfg();
	if (!cfg.clientId || !cfg.clientSecret || !cfg.guildId) {
		return res.status(503).send('Discord verification not configured');
	}

	const state = crypto.randomBytes(16).toString('hex');
	const redirectUri = getRedirectUri(req);
	const isHttps = redirectUri.startsWith('https://');

	const stateFlags = [
		`${STATE_COOKIE}=${state}`,
		'Path=/api/discord',
		'Max-Age=600',
		'SameSite=Lax',
		'HttpOnly'
	];
	if (isHttps) stateFlags.push('Secure');
	res.setHeader('Set-Cookie', stateFlags.join('; '));

	const params = new URLSearchParams({
		client_id: cfg.clientId,
		response_type: 'code',
		scope: 'identify guilds',
		redirect_uri: redirectUri,
		state,
		prompt: 'none'
	});

	res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

router.get('/callback', async (req, res) => {
	const cfg = getCfg();
	const { code, state, error: oauthError } = req.query;

	if (oauthError) {
		return renderCallbackPage(res, false, `Discord reddetti: ${oauthError}`);
	}

	const cookies = parseCookies(req);
	const expectedState = cookies[STATE_COOKIE];
	if (!code || !state || !expectedState || state !== expectedState) {
		return renderCallbackPage(res, false, 'Gecersiz istek (state mismatch).');
	}

	res.setHeader('Set-Cookie', `${STATE_COOKIE}=; Path=/api/discord; Max-Age=0; SameSite=Lax; HttpOnly`);

	try {
		const tokenResp = await exchangeCode(code, getRedirectUri(req));
		const accessToken = tokenResp.access_token;

		const [user, guilds] = await Promise.all([
			fetchDiscordUser(accessToken),
			fetchUserGuilds(accessToken)
		]);

		const guildId = String(cfg.guildId);
		const isMember = guilds.some(g => String(g.id) === guildId);

		if (!isMember) {
			return renderCallbackPage(res, false, 'Discord sunucumuzun uyesi degilsin. Once sunucuya katil, sonra tekrar dogrula.', cfg.inviteUrl);
		}

		issueVerifiedCookie(res, user.id);
		return renderCallbackPage(res, true, 'Discord dogrulamasi basarili!');

	} catch (err) {
		console.error('[discord] Callback error:', err.message, err.discordData || '');
		return renderCallbackPage(res, false, 'Discord dogrulamasi basarisiz. Tekrar dene.');
	}
});

function renderCallbackPage(res, success, message, inviteUrl) {
	const bg = success ? '#27ae60' : '#c0392b';
	const icon = success ? '&#10003;' : '&#10005;';
	const inviteBtn = (!success && inviteUrl)
		? `<a href="${inviteUrl}" target="_blank" style="display:inline-block;margin-top:12px;padding:10px 18px;background:#5865F2;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Discord'a Katil</a>`
		: '';
	res.status(200).send(`<!DOCTYPE html>
<html lang="tr"><head><meta charset="UTF-8"><title>Discord Dogrulama</title>
<style>
body{margin:0;background:#0c0c11;color:#c8c8d0;font-family:-apple-system,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;}
.box{background:#14141c;border:1px solid #252530;border-radius:12px;padding:28px 32px;max-width:420px;text-align:center;}
.ico{width:64px;height:64px;margin:0 auto 14px;background:${bg};border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:32px;font-weight:800;}
h1{font-size:1.1rem;color:#fff;margin:0 0 8px;}
p{font-size:.9rem;color:#8a8a95;line-height:1.5;margin:0 0 12px;}
.btn{display:inline-block;margin-top:14px;padding:10px 20px;background:#27ae60;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;}
.btn:hover{background:#219a52;}
</style></head><body>
<div class="box">
<div class="ico">${icon}</div>
<h1>${success ? 'Dogrulandi' : 'Dogrulama Hatasi'}</h1>
<p>${message}</p>
${success ? '<a class="btn" href="/free-commend">Ucretsiz Ovgu Sayfasina Don</a>' : '<a class="btn" href="/free-commend">Geri Don</a>'}
${inviteBtn}
</div>
<script>
try {
  if (window.opener) {
    window.opener.postMessage({ type: 'discord-verified', success: ${success ? 'true' : 'false'} }, '*');
    setTimeout(function(){ window.close(); }, 1500);
  }
} catch(e){}
</script>
</body></html>`);
}

module.exports = router;
module.exports.requireDiscordVerified = requireDiscordVerified;
module.exports.isVerified = isVerified;
