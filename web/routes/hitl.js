const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../database');
const { verifyAdmin, csrfValidate } = require('../middleware/auth');
const config = require('../config.json');
const { safeEqual } = require('../lib/password');

const INTERNAL_TOKEN = process.env.CSCOMMENDS_INTERNAL_TOKEN || '';

const SCREENSHOT_DIR = path.join(__dirname, '..', '..', 'gamesatis-automation', 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
	try { fs.mkdirSync(SCREENSHOT_DIR, { recursive: true }); } catch {}
}

function verifyInternal(req, res, next) {
	if (!INTERNAL_TOKEN) {
		return res.status(503).json({ error: 'internal_token_not_configured', hint: '.env içine CSCOMMENDS_INTERNAL_TOKEN ekle' });
	}
	const token = req.get('X-Internal-Token') || '';
	if (!safeEqual(token, INTERNAL_TOKEN)) {
		return res.status(401).json({ error: 'invalid_internal_token' });
	}
	next();
}

const sseClients = new Set();

function broadcastSSE(event, data) {
	const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	for (const res of sseClients) {
		try { res.write(payload); } catch { sseClients.delete(res); }
	}
}

function nowIso() {
	return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function expireOldChallenges() {
	const r = db.prepare(`
		UPDATE hitl_challenges
		SET status = 'expired'
		WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < datetime('now')
	`).run();
	return r.changes;
}

const _createRateBySource = new Map();
const _createRateGlobal = [];
const CREATE_WINDOW_MS = 60_000;
const CREATE_PER_SOURCE = 6;
const CREATE_GLOBAL = 30;

function _checkCreateRate(source) {
	const now = Date.now();
	while (_createRateGlobal.length && _createRateGlobal[0] < now - CREATE_WINDOW_MS) {
		_createRateGlobal.shift();
	}
	if (_createRateGlobal.length >= CREATE_GLOBAL) return { ok: false, scope: 'global' };
	let arr = _createRateBySource.get(source);
	if (!arr) { arr = []; _createRateBySource.set(source, arr); }
	while (arr.length && arr[0] < now - CREATE_WINDOW_MS) arr.shift();
	if (arr.length >= CREATE_PER_SOURCE) return { ok: false, scope: 'source' };
	arr.push(now);
	_createRateGlobal.push(now);
	if (_createRateBySource.size > 200) {
		const oldest = _createRateBySource.keys().next().value;
		_createRateBySource.delete(oldest);
	}
	return { ok: true };
}

const SCREENSHOT_TTL_MS = 24 * 60 * 60 * 1000;
function _sweepOldScreenshots() {
	try {
		if (!fs.existsSync(SCREENSHOT_DIR)) return 0;
		const cutoff = Date.now() - SCREENSHOT_TTL_MS;
		let deleted = 0;
		for (const name of fs.readdirSync(SCREENSHOT_DIR)) {
			if (!/^hitl-/.test(name)) continue;
			const full = path.join(SCREENSHOT_DIR, name);
			try {
				const st = fs.statSync(full);
				if (st.mtimeMs < cutoff) {
					fs.unlinkSync(full);
					deleted++;
				}
			} catch {  }
		}
		if (deleted > 0) console.log(`[hitl] TTL sweep: ${deleted} screenshot silindi (>24h)`);
		return deleted;
	} catch (e) {
		console.error('[hitl] TTL sweep hata:', e.message);
		return 0;
	}
}
setTimeout(_sweepOldScreenshots, 5 * 60_000).unref();
setInterval(_sweepOldScreenshots, 6 * 60 * 60_000).unref();

const router = express.Router();

router.get('/screenshot/:filename', (req, res, next) => {
	if (req.query.token && !req.headers.authorization) {
		req.headers.authorization = 'Bearer ' + req.query.token;
	}
	next();
}, verifyAdmin, (req, res) => {
	const fname = req.params.filename;
	if (!/^[\w\-.]+\.(png|jpg|jpeg|webp)$/i.test(fname)) {
		return res.status(400).send('invalid filename');
	}
	const fpath = path.join(SCREENSHOT_DIR, fname);
	if (!fs.existsSync(fpath)) return res.status(404).send('not found');
	res.sendFile(fpath);
});

const adminRouter = express.Router();
adminRouter.use(verifyAdmin);

adminRouter.get('/pending', (req, res) => {
	expireOldChallenges();
	const items = db.prepare(`
		SELECT id, type, source, prompt, screenshot_path, status, metadata, created_at, expires_at
		FROM hitl_challenges
		WHERE status = 'pending'
		ORDER BY created_at ASC
	`).all();
	res.json({ items });
});

adminRouter.get('/recent', (req, res) => {
	const limit = Math.min(parseInt(req.query.limit) || 20, 100);
	const items = db.prepare(`
		SELECT id, type, source, prompt, status, answer, created_at, resolved_at
		FROM hitl_challenges
		ORDER BY id DESC
		LIMIT ?
	`).all(limit);
	res.json({ items });
});

adminRouter.post('/resolve/:id', (req, res) => {
	const id = parseInt(req.params.id);
	const { answer } = req.body || {};
	if (typeof answer !== 'string' || answer.length === 0 || answer.length > 500) {
		return res.status(400).json({ error: 'invalid_answer' });
	}
	const r = db.prepare(`
		UPDATE hitl_challenges
		SET status = 'resolved', answer = ?, resolved_at = datetime('now')
		WHERE id = ? AND status = 'pending'
	`).run(answer, id);
	if (r.changes === 0) {
		const cur = db.prepare('SELECT status FROM hitl_challenges WHERE id = ?').get(id);
		return res.status(400).json({ error: 'not_pending', currentStatus: cur?.status });
	}
	broadcastSSE('hitl:resolved', { id });
	res.json({ success: true });
});

adminRouter.post('/cancel/:id', (req, res) => {
	const id = parseInt(req.params.id);
	const r = db.prepare(`
		UPDATE hitl_challenges
		SET status = 'cancelled', resolved_at = datetime('now')
		WHERE id = ? AND status = 'pending'
	`).run(id);
	if (r.changes === 0) return res.status(400).json({ error: 'not_pending' });
	broadcastSSE('hitl:cancelled', { id });
	res.json({ success: true });
});

adminRouter.get('/stream', (req, res) => {
	res.set({
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
		'X-Accel-Buffering': 'no'
	});
	res.flushHeaders();
	res.write(': hitl-stream-open\n\n');

	sseClients.add(res);
	const heartbeat = setInterval(() => {
		try { res.write(': hb\n\n'); } catch {}
	}, 25000);

	req.on('close', () => {
		clearInterval(heartbeat);
		sseClients.delete(res);
	});
});

router.use('/admin', csrfValidate, adminRouter);

const internalRouter = express.Router();
internalRouter.use(verifyInternal);

internalRouter.post('/create', (req, res) => {
	const { type, source, prompt, screenshot, expiresInSec, metadata } = req.body || {};

	if (!['captcha', 'sms', 'generic', '2fa'].includes(type)) {
		return res.status(400).json({ error: 'invalid_type' });
	}
	if (typeof source !== 'string' || source.length > 100) {
		return res.status(400).json({ error: 'invalid_source' });
	}

	const rl = _checkCreateRate(source);
	if (!rl.ok) {
		return res.status(429).json({ error: 'rate_limited', scope: rl.scope, retry_after_sec: 60 });
	}

	const cancelled = db.prepare(`UPDATE hitl_challenges SET status='cancelled', resolved_at=datetime('now') WHERE source = ? AND status='pending'`).run(source);
	if (cancelled.changes > 0) {
		console.log(`[hitl] ${cancelled.changes} eski pending cancel edildi (source=${source})`);
	}

	let screenshotPath = null;
	if (screenshot && typeof screenshot === 'string' && screenshot.length < 5_000_000) {
		try {
			const m = screenshot.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
			if (m) {
				const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
				const filename = `hitl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
				fs.writeFileSync(path.join(SCREENSHOT_DIR, filename), Buffer.from(m[2], 'base64'));
				screenshotPath = `/api/hitl/screenshot/${filename}`;
			}
		} catch (err) {
			console.error('[hitl] screenshot save failed:', err.message);
		}
	}

	const expSec = Math.min(Math.max(parseInt(expiresInSec) || 600, 30), 3600);
	const expiresAt = new Date(Date.now() + expSec * 1000).toISOString().slice(0, 19).replace('T', ' ');

	const ins = db.prepare(`
		INSERT INTO hitl_challenges (type, source, prompt, screenshot_path, status, metadata, expires_at)
		VALUES (?, ?, ?, ?, 'pending', ?, ?)
	`).run(
		type,
		source,
		prompt ? String(prompt).slice(0, 1000) : null,
		screenshotPath,
		metadata ? JSON.stringify(metadata).slice(0, 5000) : null,
		expiresAt
	);

	try {
		const config = require('../../config.json');
		if (config.webhookUrl) {
			const fetch = global.fetch || require('node-fetch');
			fetch(config.webhookUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					content: `🚨 **HITL müdahale bekliyor** — ${type} (${source})\n${prompt ? prompt.slice(0, 200) : ''}\n👉 https://cscommends.com/admin (🔔 bell)`
				})
			}).catch(() => {});
		}
	} catch {}

	const item = db.prepare(`
		SELECT id, type, source, prompt, screenshot_path, status, metadata, created_at, expires_at
		FROM hitl_challenges WHERE id = ?
	`).get(ins.lastInsertRowid);

	broadcastSSE('hitl:new', item);

	res.json({ success: true, id: ins.lastInsertRowid, expiresAt });
});

internalRouter.get('/poll/:id', async (req, res) => {
	const id = parseInt(req.params.id);
	const startedAt = Date.now();
	const MAX_WAIT_MS = 25000;
	const POLL_MS = 1000;

	while (Date.now() - startedAt < MAX_WAIT_MS) {
		const row = db.prepare(`
			SELECT id, status, answer, resolved_at FROM hitl_challenges WHERE id = ?
		`).get(id);

		if (!row) return res.status(404).json({ error: 'not_found' });

		if (row.status !== 'pending') {
			return res.json({
				id: row.id,
				status: row.status,
				answer: row.answer || null,
				resolvedAt: row.resolved_at
			});
		}

		await new Promise(r => setTimeout(r, POLL_MS));
	}

	res.json({ id, status: 'pending', timeout: true });
});

internalRouter.post('/cancel/:id', (req, res) => {
	const id = parseInt(req.params.id);
	const r = db.prepare(`
		UPDATE hitl_challenges
		SET status = 'cancelled', resolved_at = datetime('now')
		WHERE id = ? AND status = 'pending'
	`).run(id);
	if (r.changes === 0) return res.status(400).json({ error: 'not_pending' });
	broadcastSSE('hitl:cancelled', { id });
	res.json({ success: true });
});

router.use('/internal', internalRouter);

module.exports = router;
