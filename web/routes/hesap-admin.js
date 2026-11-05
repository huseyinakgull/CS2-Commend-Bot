const express = require('express');
const { verifyAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(verifyAdmin);

function getMgr(req) { return req.app.locals.hesap; }

router.get('/status', (req, res) => {
	const mgr = getMgr(req);
	if (!mgr) return res.status(503).json({ error: 'hesap_manager_not_initialized' });
	res.json(mgr.getStatus());
});

router.post('/login', async (req, res) => {
	const mgr = getMgr(req);
	if (!mgr) return res.status(503).json({ error: 'hesap_manager_not_initialized' });
	if (mgr.busy) return res.status(409).json({ error: 'busy', currentOp: mgr._currentOp });
	try {
		mgr.login()
			.then(r => console.log(`[hesap-admin] login: ${JSON.stringify(r)}`))
			.catch(err => console.error(`[hesap-admin] login err: ${err.message}`));
		res.json({ accepted: true, status: mgr.getStatus(), note: 'Login akışı async başlatıldı — kullanıcı RDP ile Google OAuth tamamlamalı (5dk timeout)' });
	} catch (err) {
		console.error('[hesap-admin/login]', err);
		res.status(500).json({ error: 'Hesap login başlatılamadı' });
	}
});

router.post('/check', async (req, res) => {
	const mgr = getMgr(req);
	if (!mgr) return res.status(503).json({ error: 'hesap_manager_not_initialized' });
	try {
		if (mgr.busy) return res.status(409).json({ error: 'busy', currentOp: mgr._currentOp });
		const result = await mgr.check();
		res.json({ ...result, status: mgr.getStatus() });
	} catch (err) {
		console.error('[hesap-admin/check]', err);
		res.status(500).json({ error: 'Hesap kontrol edilemedi', status: mgr.getStatus() });
	}
});

router.post('/stop', async (req, res) => {
	const mgr = getMgr(req);
	if (!mgr) return res.status(503).json({ error: 'hesap_manager_not_initialized' });
	try {
		if (mgr.busy && mgr._currentOp !== 'login') {
			return res.status(409).json({ error: 'busy', currentOp: mgr._currentOp });
		}
		const result = await mgr.stop();
		res.json({ ...result, status: mgr.getStatus() });
	} catch (err) {
		console.error('[hesap-admin/stop]', err);
		res.status(500).json({ error: 'Hesap durdurulamadı' });
	}
});

router.post('/poll-now', async (req, res) => {
	const mgr = getMgr(req);
	if (!mgr) return res.status(503).json({ error: 'hesap_manager_not_initialized' });
	if (mgr.busy) return res.status(409).json({ error: 'busy', currentOp: mgr._currentOp });
	try {
		const r = await mgr.pollOnce();
		res.json({ success: true, ...r, status: mgr.getStatus() });
	} catch (err) {
		console.error('[hesap-admin/poll-now]', err);
		res.status(500).json({ error: 'Poll işlemi başarısız', status: mgr.getStatus() });
	}
});

router.post('/polling/start', (req, res) => {
	const mgr = getMgr(req);
	if (!mgr) return res.status(503).json({ error: 'hesap_manager_not_initialized' });
	const r = mgr.startPolling();
	res.json({ ...r, status: mgr.getStatus() });
});

router.post('/polling/stop', (req, res) => {
	const mgr = getMgr(req);
	if (!mgr) return res.status(503).json({ error: 'hesap_manager_not_initialized' });
	const r = mgr.stopPolling();
	res.json({ ...r, status: mgr.getStatus() });
});

router.post('/reactivate-listings', async (req, res) => {
	const mgr = getMgr(req);
	if (!mgr) return res.status(503).json({ error: 'hesap_manager_not_initialized' });
	if (mgr.busy) return res.status(409).json({ error: 'busy', currentOp: mgr._currentOp });
	try {
		const r = await mgr.reactivatePassive();
		res.json({ success: true, ...r, status: mgr.getStatus() });
	} catch (err) {
		console.error('[hesap-admin/reactivate-listings]', err);
		res.status(500).json({ error: 'İlan yeniden aktifleştirilemedi', status: mgr.getStatus() });
	}
});

router.get('/orders', (req, res) => {
	const orderState = require('../../hesap-automation/lib/order-state');
	const limit = Math.min(parseInt(req.query.limit) || 50, 200);
	res.json({
		stats: orderState.getStats(),
		orders: orderState.listProcessed(limit)
	});
});

module.exports = router;
