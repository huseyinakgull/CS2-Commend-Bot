const express = require('express');
const { verifyAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(verifyAdmin);

function getMgr(req) { return req.app.locals.gamesatis; }

router.get('/status', (req, res) => {
	const mgr = getMgr(req);
	if (!mgr) return res.status(503).json({ error: 'gamesatis_manager_not_initialized' });
	res.json(mgr.getStatus());
});

router.post('/login', async (req, res) => {
	const mgr = getMgr(req);
	if (!mgr) return res.status(503).json({ error: 'gamesatis_manager_not_initialized' });
	try {
		if (mgr.busy) {
			return res.status(409).json({ error: 'busy', currentOp: mgr._currentOp });
		}
		mgr.login()
			.then(r => req.app.locals.eventLog && req.app.locals.eventLog('audit', `gamesatis login: ${JSON.stringify(r)}`, {}))
			.catch(err => req.app.locals.eventLog && req.app.locals.eventLog('error', `gamesatis login: ${err.message}`, {}));
		res.json({ accepted: true, status: mgr.getStatus() });
	} catch (err) {
		console.error('[gamesatis-admin/login]', err);
		res.status(500).json({ error: 'Gamesatis login başlatılamadı' });
	}
});

router.post('/check', async (req, res) => {
	const mgr = getMgr(req);
	if (!mgr) return res.status(503).json({ error: 'gamesatis_manager_not_initialized' });
	try {
		if (mgr.busy) return res.status(409).json({ error: 'busy', currentOp: mgr._currentOp });
		const result = await mgr.check();
		res.json({ ...result, status: mgr.getStatus() });
	} catch (err) {
		console.error('[gamesatis-admin/check]', err);
		res.status(500).json({ error: 'Gamesatis kontrol edilemedi', status: mgr.getStatus() });
	}
});

router.post('/stop', async (req, res) => {
	const mgr = getMgr(req);
	if (!mgr) return res.status(503).json({ error: 'gamesatis_manager_not_initialized' });
	try {
		if (mgr.busy && mgr._currentOp !== 'login') {
			return res.status(409).json({ error: 'busy', currentOp: mgr._currentOp });
		}
		const result = await mgr.stop();
		res.json({ ...result, status: mgr.getStatus() });
	} catch (err) {
		console.error('[gamesatis-admin/stop]', err);
		res.status(500).json({ error: 'Gamesatis durdurulamadı' });
	}
});

router.post('/poll-now', async (req, res) => {
	const mgr = getMgr(req);
	if (!mgr) return res.status(503).json({ error: 'gamesatis_manager_not_initialized' });
	if (mgr.busy) return res.status(409).json({ error: 'busy', currentOp: mgr._currentOp });
	try {
		const r = await mgr.pollOnce();
		res.json({ success: true, ...r, status: mgr.getStatus() });
	} catch (err) {
		console.error('[gamesatis-admin/poll-now]', err);
		res.status(500).json({ error: 'Poll işlemi başarısız', status: mgr.getStatus() });
	}
});

router.post('/polling/start', (req, res) => {
	const mgr = getMgr(req);
	if (!mgr) return res.status(503).json({ error: 'gamesatis_manager_not_initialized' });
	const r = mgr.startPolling();
	res.json({ ...r, status: mgr.getStatus() });
});

router.post('/polling/stop', (req, res) => {
	const mgr = getMgr(req);
	if (!mgr) return res.status(503).json({ error: 'gamesatis_manager_not_initialized' });
	const r = mgr.stopPolling();
	res.json({ ...r, status: mgr.getStatus() });
});

router.get('/scan-inbox', async (req, res) => {
	const mgr = getMgr(req);
	if (!mgr) return res.status(503).json({ error: 'gamesatis_manager_not_initialized' });
	if (mgr.busy) return res.status(409).json({ error: 'busy', currentOp: mgr._currentOp });
	try {
		const r = await mgr.scanInbox({
			messagesPerChat: parseInt(req.query.limit) || 10,
			maxChats: parseInt(req.query.max) || 25
		});
		res.json({ success: true, ...r, status: mgr.getStatus() });
	} catch (err) {
		console.error('[gamesatis-admin/scan-inbox]', err);
		res.status(500).json({ error: 'Inbox taranamadı', status: mgr.getStatus() });
	}
});

router.post('/reactivate-listings', async (req, res) => {
	const mgr = getMgr(req);
	if (!mgr) return res.status(503).json({ error: 'gamesatis_manager_not_initialized' });
	if (mgr.busy) return res.status(409).json({ error: 'busy', currentOp: mgr._currentOp });
	try {
		const r = await mgr.reactivateOutOfStock();
		res.json({ success: true, ...r, status: mgr.getStatus() });
	} catch (err) {
		console.error('[gamesatis-admin/reactivate-listings]', err);
		res.status(500).json({ error: 'İlan yeniden aktifleştirilemedi', status: mgr.getStatus() });
	}
});

router.get('/orders', (req, res) => {
	const orderState = require('../../gamesatis-automation/lib/order-state');
	const limit = Math.min(parseInt(req.query.limit) || 50, 200);
	res.json({
		stats: orderState.getStats(),
		orders: orderState.listProcessed(limit)
	});
});

router.get('/inspect-satislarim', async (req, res) => {
	const mgr = getMgr(req);
	if (!mgr) return res.status(503).json({ error: 'gamesatis_manager_not_initialized' });
	if (mgr.busy) return res.status(409).json({ error: 'busy', currentOp: mgr._currentOp });
	const path = require('path');
	const fs = require('fs');
	try {
		const r = await mgr._withMutex('inspect', async () => {
			const browser = await mgr._ensureBrowser();
			const targetUrl = req.query.url || 'https://www.gamesatis.com/satislarim';
			await browser.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
			await browser.page.waitForTimeout(2500);

			const ssDir = path.join(__dirname, '..', '..', 'gamesatis-automation', 'screenshots');
			if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true });
			const ssPath = path.join(ssDir, `inspect-${Date.now()}.png`);
			await browser.page.screenshot({ path: ssPath, fullPage: true });

			const debug = await browser.page.evaluate(() => {
				const orderIdRegex = /#(7\d{6})/;
				const candidates = [];
				const allDivs = document.querySelectorAll('div, article, section, li, tr');
				allDivs.forEach(el => {
					const txt = el.innerText || '';
					const m = txt.match(orderIdRegex);
					if (!m) return;
					if (txt.length > 2000) return;
					const buttons = Array.from(el.querySelectorAll('button')).map(b => (b.innerText || '').trim()).filter(Boolean);
					const inputs = Array.from(el.querySelectorAll('input,form')).map(i => i.outerHTML.slice(0, 120));
					candidates.push({
						orderId: m[1],
						className: (el.className || '').toString().slice(0, 100),
						tag: el.tagName.toLowerCase(),
						buttons,
						inputs: inputs.slice(0, 3),
						textPreview: txt.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 10)
					});
				});

				const byId = new Map();
				for (const c of candidates) {
					const exist = byId.get(c.orderId);
					if (!exist || c.textPreview.join(' ').length < exist.textPreview.join(' ').length) {
						byId.set(c.orderId, c);
					}
				}

				return {
					url: location.href,
					title: document.title,
					bodySnippet: (document.body.innerText || '').slice(0, 1000),
					itemDetailCount: document.querySelectorAll('.item-detail.sale-detail').length,
					anyItemDetailCount: document.querySelectorAll('[class*="item-detail"]').length,
					anySaleClassCount: document.querySelectorAll('[class*="sale"]').length,
					orderIdCandidates: Array.from(byId.values()),
					tabActiveText: (document.querySelector('button.active, .tab.active, [class*="active"]')?.innerText || '').slice(0, 50)
				};
			});

			return { ...debug, screenshotPath: '/api/hitl/screenshot/' + path.basename(ssPath) };
		});
		res.json(r);
	} catch (err) {
		console.error('[gamesatis-admin/debug]', err);
		res.status(500).json({ error: 'Debug snapshot alınamadı' });
	}
});

module.exports = router;
