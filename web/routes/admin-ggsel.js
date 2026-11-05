const express = require('express');
const db = require('../database');
const { verifyAdmin } = require('../middleware/auth');
const { getClient, HOST, API_BASE } = require('../lib/ggsel-client');

const router = express.Router();
router.use(verifyAdmin);

function loadTokens() {
	return {
		accessToken: db.getSetting('ggsel.access_token', null) || null,
		refreshToken: db.getSetting('ggsel.refresh_token', null) || null,
		chatToken: db.getSetting('ggsel.chat_token', null) || null,
		expiresAt: parseInt(db.getSetting('ggsel.expires_at', '0'), 10) || 0,
		email: db.getSetting('ggsel.email', null) || null
	};
}

function persistTokens(state) {
	db.setSetting('ggsel.access_token', state.accessToken || '');
	db.setSetting('ggsel.refresh_token', state.refreshToken || '');
	db.setSetting('ggsel.chat_token', state.chatToken || '');
	db.setSetting('ggsel.expires_at', String(state.expiresAt || 0));
	if (state.email) db.setSetting('ggsel.email', state.email);
}

function applyToClient() {
	const t = loadTokens();
	getClient().configure({
		accessToken: t.accessToken,
		refreshToken: t.refreshToken,
		chatToken: t.chatToken,
		email: t.email,
		expiresAt: t.expiresAt,
		onChange: persistTokens
	});
	return t;
}

applyToClient();

function send(res, ggResp) {
	res.status(200).json(ggResp);
}

router.get('/settings', (req, res) => {
	const t = loadTokens();
	res.json({
		hasToken: !!t.accessToken,
		email: t.email,
		expiresAt: t.expiresAt,
		expired: !t.expiresAt || Date.now() >= t.expiresAt - 60_000,
		tokenPreview: t.accessToken ? (t.accessToken.substring(0, 12) + '...' + t.accessToken.slice(-6)) : null,
		baseUrl: 'https://' + HOST + API_BASE
	});
});

router.post('/settings/clear', async (req, res) => {
	db.setSetting('ggsel.access_token', '');
	db.setSetting('ggsel.refresh_token', '');
	db.setSetting('ggsel.chat_token', '');
	db.setSetting('ggsel.expires_at', '0');
	db.setSetting('ggsel.email', '');
	applyToClient();
	res.json({ ok: true });
});

router.post('/login', async (req, res) => {
	const { email, password } = req.body || {};
	if (!email || !password) return res.json({ ok: false, error: 'email_password_required' });

	applyToClient();
	const r = await getClient().login(email, password);
	if (r.ok) {
		db.setSetting('ggsel.email', email);
		applyToClient();
	}
	res.json(r);
});

router.post('/set-token', async (req, res) => {
	const { accessToken, refreshToken, expiresIn, email } = req.body || {};
	if (!accessToken) return res.json({ ok: false, error: 'access_token_required' });
	const expiresAt = expiresIn ? Date.now() + parseInt(expiresIn, 10) * 1000 : Date.now() + 7200_000;
	db.setSetting('ggsel.access_token', accessToken);
	if (refreshToken) db.setSetting('ggsel.refresh_token', refreshToken);
	db.setSetting('ggsel.expires_at', String(expiresAt));
	if (email) db.setSetting('ggsel.email', email);
	applyToClient();
	res.json({ ok: true });
});

router.post('/refresh', async (req, res) => {
	res.json({ ok: false, error: 'Refresh not supported. Please re-login from settings.' });
});

router.post('/logout', async (req, res) => {
	applyToClient();
	const r = await getClient().logout();
	db.setSetting('ggsel.access_token', '');
	db.setSetting('ggsel.refresh_token', '');
	db.setSetting('ggsel.chat_token', '');
	db.setSetting('ggsel.expires_at', '0');
	applyToClient();
	send(res, r);
});

router.post('/test-connection', async (req, res) => {
	applyToClient();
	const r = await getClient().testConnection();
	send(res, r);
});

router.post('/proxy', async (req, res) => {
	applyToClient();
	const { method = 'GET', endpoint, query, body } = req.body || {};
	if (!endpoint || !endpoint.startsWith('/')) return res.json({ ok: false, error: 'endpoint_must_start_with_slash' });
	const r = await getClient().rawCall(method, endpoint, { query, body });
	send(res, r);
});

const ENDPOINT_MAP = [
	['GET', '/dashboard',                    'dashboard'],

	['GET', '/account/balance',              'accountBalance'],
	['GET', '/account/currencies',           'accountCurrencies'],
	['GET', '/account/notifications',        'notifications'],

	['GET', '/users/me',                     'usersMe'],

	['GET', '/api-keys',                     'apiKeysList',         'query'],
	['POST', '/api-keys',                    'apiKeyCreate',        'body'],
	['GET', '/api-keys/permissions',         'apiKeyPermissions'],
	['GET', '/api-keys/:id',                 'apiKeyDetail',        'param:id'],
	['POST', '/api-keys/:id/revoke',         'apiKeyRevoke',        'param:id'],
	['POST', '/api-keys/:id/resend',         'apiKeyResendNotification', 'param:id'],

	['GET', '/categories',                   'categoriesList',      'query'],
	['GET', '/categories/filter',            'categoriesFilterList'],
	['GET', '/categories/search',            'categoriesSearch',    'query'],
	['GET', '/categories/:id',               'categoryDetail',      'param:id'],
	['GET', '/categories/:id/tree',          'categoryTree',        'param:id'],

	['GET', '/conversations',                'conversationsList',   'query'],
	['GET', '/conversations/:id',            'conversationDetail',  'param:id'],
	['POST', '/conversations/:id/read',      'conversationMarkRead', 'param:id'],

	['GET', '/orders',                       'ordersList',          'query'],
	['GET', '/orders/delivery-statuses',     'ordersDeliveryStatuses'],
	['GET', '/orders/offers',                'ordersOffers',        'query'],
	['GET', '/orders/:id',                   'orderDetail',         'param:id'],
	['POST', '/orders/batch/delivered',      'ordersBatchDelivered', 'body:ids'],
	['POST', '/orders/batch/pending',        'ordersBatchPending',  'body:ids'],

	['GET', '/offers',                       'offersList',          'query'],
	['GET', '/offers/filter',                'offersFilterList'],
	['GET', '/offers/:id',                   'offerDetail',         'param:id'],
	['PUT', '/offers/:id',                   'offerUpdate',         'param:id+body'],
	['DELETE', '/offers/:id',                'offerDelete',         'param:id'],
	['POST', '/offers/:id/duplicate',        'offerDuplicate',      'param:id'],
	['POST', '/offers/draft',                'offerCreateDraft',    'body'],
	['POST', '/offers/batch/activate',       'offersBatchActivate', 'body:ids'],
	['POST', '/offers/batch/pause',          'offersBatchPause',    'body:ids'],
	['POST', '/offers/batch/delete',         'offersBatchDelete',   'body:ids'],
	['GET', '/offers/ggsel/:id',             'offersGgselDetail',   'param:id'],

	['GET', '/wallets',                      'walletsList'],
	['POST', '/wallets',                     'walletCreate',        'body'],
	['DELETE', '/wallets/:id',               'walletDelete',        'param:id'],
	['POST', '/wallets/code',                'walletCode',          'body'],
	['POST', '/wallets/validate',            'walletValidate',      'body'],

	['POST', '/withdrawals',                 'withdrawalCreate',    'body'],
	['GET', '/withdrawals/calculate',        'withdrawalCalculate', 'query'],

	['GET', '/invoices/:id',                 'invoiceDetail',       'param:id'],
	['POST', '/invoices/top-up',             'invoiceTopUp',        'body'],
	['GET', '/invoices/top-up/calculate',    'invoiceTopUpCalculate', 'query'],

	['GET', '/ledger',                       'ledgerList',          'query'],
	['GET', '/ledger/:id',                   'ledgerDetail',        'param:id'],

	['GET', '/summpays',                     'summpaysList',        'query'],
	['POST', '/summpays',                    'summpaysCreate',      'body'],
	['GET', '/summpays/categories',          'summpaysCategories'],
	['GET', '/summpays/categories/:id',      'summpaysCategoryDetail', 'param:id'],
	['GET', '/summpays/table-view',          'summpaysTableView',   'query']
];

for (const [method, route, clientFn, paramSpec] of ENDPOINT_MAP) {
	router[method.toLowerCase()](route, async (req, res) => {
		applyToClient();
		const c = getClient();
		if (typeof c[clientFn] !== 'function') return send(res, { ok: false, error: 'method_not_implemented' });
		try {
			let r;
			if (!paramSpec) r = await c[clientFn]();
			else if (paramSpec === 'query') r = await c[clientFn](req.query);
			else if (paramSpec === 'body') r = await c[clientFn](req.body);
			else if (paramSpec === 'body:ids') r = await c[clientFn](req.body && req.body.ids);
			else if (paramSpec === 'param:id') r = await c[clientFn](req.params.id);
			else if (paramSpec === 'param:id+body') r = await c[clientFn](req.params.id, req.body);
			else r = { ok: false, error: 'unknown_param_spec' };
			send(res, r);
		} catch (err) {
			console.error(`[admin-ggsel/${clientFn}]`, err);
			send(res, { ok: false, error: 'GGsel isteği başarısız' });
		}
	});
}

module.exports = router;
