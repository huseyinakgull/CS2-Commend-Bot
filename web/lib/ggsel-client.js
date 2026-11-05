const https = require('https');

const HOST = 'seller.ggsel.com';
const LOGIN_PATH = '/api/auth/login';
const API_BASE = '/api/v1';

const DEFAULT_HEADERS = {
	'Accept': 'application/json',
	'Content-Type': 'application/json',
	'User-Agent': 'Mozilla/5.0 (compatible; CSCommends-GGselClient/1.0)',
	'Origin': 'https://seller.ggsel.com',
	'Referer': 'https://seller.ggsel.com/'
};

function rawHttps({ method, path, body, headers = {}, timeout = 15000 }) {
	return new Promise((resolve) => {
		const reqHeaders = { ...DEFAULT_HEADERS, ...headers };
		let bodyStr = null;
		if (body) {
			bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
			reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);
		}

		const req = https.request({
			hostname: HOST,
			path,
			method,
			headers: reqHeaders,
			timeout
		}, (res) => {
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => {
				const raw = Buffer.concat(chunks).toString('utf8');
				let data;
				try { data = JSON.parse(raw); } catch { data = null; }
				resolve({
					status: res.statusCode,
					headers: res.headers,
					setCookies: parseSetCookies(res.headers['set-cookie'] || []),
					raw,
					data
				});
			});
		});
		req.on('error', (err) => resolve({ status: 0, error: err.message, raw: '', data: null, setCookies: {} }));
		req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout', raw: '', data: null, setCookies: {} }); });
		if (bodyStr) req.write(bodyStr);
		req.end();
	});
}

function parseSetCookies(cookieArr) {
	const out = {};
	for (const c of cookieArr) {
		const m = c.match(/^([^=]+)=([^;]*)/);
		if (m) out[m[1]] = m[2];
	}
	return out;
}

class GGselClient {
	constructor(opts = {}) {
		this.accessToken = opts.accessToken || null;
		this.refreshToken = opts.refreshToken || null;
		this.chatToken = opts.chatToken || null;
		this.email = opts.email || null;
		this.expiresAt = opts.expiresAt || 0;
		this._onChange = opts.onChange || null;
	}

	configure(opts) {
		if (opts.accessToken !== undefined) this.accessToken = opts.accessToken;
		if (opts.refreshToken !== undefined) this.refreshToken = opts.refreshToken;
		if (opts.chatToken !== undefined) this.chatToken = opts.chatToken;
		if (opts.email !== undefined) this.email = opts.email;
		if (opts.expiresAt !== undefined) this.expiresAt = opts.expiresAt;
		if (opts.onChange !== undefined) this._onChange = opts.onChange;
	}

	_persist() {
		if (this._onChange) {
			try {
				this._onChange({
					accessToken: this.accessToken,
					refreshToken: this.refreshToken,
					chatToken: this.chatToken,
					email: this.email,
					expiresAt: this.expiresAt
				});
			} catch {}
		}
	}

	_buildCookie() {
		const parts = [];
		if (this.accessToken) parts.push('ACCESS_TOKEN=' + this.accessToken);
		if (this.refreshToken) parts.push('REFRESH_TOKEN=' + this.refreshToken);
		if (this.chatToken) parts.push('CHAT_TOKEN=' + this.chatToken);
		return parts.join('; ');
	}

	async login(email, password) {
		const r = await rawHttps({
			method: 'POST',
			path: LOGIN_PATH,
			body: { email, password }
		});
		if (r.status === 200 && r.data && r.data.success) {
			this.accessToken = r.setCookies.ACCESS_TOKEN || r.data.accessToken || null;
			this.refreshToken = r.setCookies.REFRESH_TOKEN || null;
			this.chatToken = r.setCookies.CHAT_TOKEN || null;
			this.email = email;
			this.expiresAt = Date.now() + 24 * 3600 * 1000;
			this._persist();
			return { ok: true, data: r.data, user: { email } };
		}
		return {
			ok: false,
			status: r.status,
			error: (r.data && (r.data.error || r.data.message)) || r.error || 'login_failed',
			data: r.data,
			raw: r.raw
		};
	}

	async logout() {
		if (!this.accessToken) return { ok: true };
		const r = await this._call('POST', '/auth/logout');
		this.accessToken = null;
		this.refreshToken = null;
		this.chatToken = null;
		this.expiresAt = 0;
		this._persist();
		return r;
	}

	isExpired() {
		if (!this.accessToken) return true;
		return Date.now() >= this.expiresAt - 60_000;
	}

	async _call(method, endpoint, opts = {}) {
		if (!this.accessToken) {
			return { ok: false, status: 0, error: 'not_authenticated', data: null };
		}

		let path = API_BASE + endpoint;
		if (opts.query) {
			const qp = new URLSearchParams();
			for (const [k, v] of Object.entries(opts.query)) {
				if (v !== undefined && v !== null && v !== '') qp.append(k, String(v));
			}
			const qs = qp.toString();
			if (qs) path += '?' + qs;
		}

		const headers = { Cookie: this._buildCookie() };
		const r = await rawHttps({ method, path, body: opts.body, headers });
		return this._formatResp(r);
	}

	_formatResp(r) {
		const ok = r.status >= 200 && r.status < 300;
		let error = null;
		if (!ok) {
			error = r.error
				|| (r.data && (
					(Array.isArray(r.data.errors) && r.data.errors[0]) ||
					r.data.error_description ||
					r.data.error ||
					r.data.message
				))
				|| `http_${r.status}`;
		}
		return { ok, status: r.status, data: r.data, raw: r.raw, error };
	}

	async testConnection()     { return this._call('GET', '/users/me'); }

	async usersMe()            { return this._call('GET', '/users/me'); }
	async updateContacts(b)    { return this._call('PATCH', '/users/contacts', { body: b }); }
	async updateLocale(locale) { return this._call('PATCH', '/users/locale', { body: { locale } }); }
	async updatePassword(b)    { return this._call('POST', '/users/password', { body: b }); }
	async updateUsername(name) { return this._call('POST', '/users/username', { body: { username: name } }); }

	async dashboard()          { return this._call('GET', '/dashboard'); }

	async accountBalance()     { return this._call('GET', '/account/balance'); }
	async accountCurrencies()  { return this._call('GET', '/account/available_currencies'); }
	async notifications()      { return this._call('GET', '/account/notifications'); }
	async setEmailEnabled(v)   { return this._call('PATCH', '/account/notifications/email_enabled', { body: { value: !!v } }); }
	async linkTelegram(b)      { return this._call('POST', '/account/notifications/link_telegram', { body: b }); }
	async unlinkTelegram()     { return this._call('POST', '/account/notifications/unlink_telegram'); }
	async resendTelegramCode() { return this._call('POST', '/account/notifications/resend_telegram_code'); }
	async validateTelegramCode(code) { return this._call('POST', '/account/notifications/validate_telegram_code', { body: { code } }); }
	async setMessagesWebhook(url)    { return this._call('PUT', '/account/notifications/new_messages_webhook', { body: { url } }); }
	async updateTelegramSettings(o)  { return this._call('PATCH', '/account/notifications/update_telegram_settings', { body: o }); }

	async apiKeysList(query)            { return this._call('GET', '/api_keys', { query }); }
	async apiKeyCreate(body)            { return this._call('POST', '/api_keys', { body }); }
	async apiKeyDetail(id)              { return this._call('GET', `/api_keys/${encodeURIComponent(id)}`); }
	async apiKeyRevoke(id)              { return this._call('POST', `/api_keys/${encodeURIComponent(id)}/revoke`); }
	async apiKeyResendNotification(id)  { return this._call('POST', `/api_keys/${encodeURIComponent(id)}/resend_notification`); }
	async apiKeyPermissions()           { return this._call('GET', '/api_keys/permission_list'); }

	async categoriesList(query)    { return this._call('GET', '/categories', { query }); }
	async categoryDetail(id)       { return this._call('GET', `/categories/${encodeURIComponent(id)}`); }
	async categoryTree(id)         { return this._call('GET', `/categories/${encodeURIComponent(id)}/tree`); }
	async categoriesFilterList()   { return this._call('GET', '/categories/filter_list'); }
	async categoriesSearch(query)  { return this._call('GET', '/categories/search', { query }); }

	async conversationsList(query)   { return this._call('GET', '/conversations', { query }); }
	async conversationDetail(id)     { return this._call('GET', `/conversations/${encodeURIComponent(id)}`); }
	async conversationMarkRead(id)   { return this._call('POST', `/conversations/${encodeURIComponent(id)}/mark_as_read`); }

	async ordersList(query)              { return this._call('GET', '/orders', { query }); }
	async orderDetail(id)                { return this._call('GET', `/orders/${encodeURIComponent(id)}`); }
	async ordersDeliveryStatuses()       { return this._call('GET', '/orders/delivery_statuses'); }
	async ordersOffers(query)            { return this._call('GET', '/orders/offers', { query }); }
	async ordersBatchDelivered(ids)      { return this._call('POST', '/orders/batch/actions/deliveries/delivered', { body: { ids } }); }
	async ordersBatchPending(ids)        { return this._call('POST', '/orders/batch/actions/deliveries/pending', { body: { ids } }); }

	async offersList(query)              { return this._call('GET', '/offers', { query }); }
	async offerDetail(id)                { return this._call('GET', `/offers/${encodeURIComponent(id)}`); }
	async offerUpdate(id, body)          { return this._call('PUT', `/offers/${encodeURIComponent(id)}`, { body }); }
	async offerDelete(id)                { return this._call('DELETE', `/offers/${encodeURIComponent(id)}`); }
	async offerDuplicate(id)             { return this._call('POST', `/offers/${encodeURIComponent(id)}/duplicate`); }
	async offerCreateDraft(body)         { return this._call('POST', '/offers/draft', { body }); }
	async offersFilterList()             { return this._call('GET', '/offers/filter_list'); }
	async offersBatchActivate(ids)       { return this._call('POST', '/offers/batch/actions/activate', { body: { ids } }); }
	async offersBatchPause(ids)          { return this._call('POST', '/offers/batch/actions/pause', { body: { ids } }); }
	async offersBatchDelete(ids)         { return this._call('POST', '/offers/batch/actions/delete', { body: { ids } }); }
	async offersGgselDetail(id)          { return this._call('GET', `/offers/ggsel/${encodeURIComponent(id)}`); }

	async walletsList()                  { return this._call('GET', '/wallets'); }
	async walletCreate(body)             { return this._call('POST', '/wallets', { body }); }
	async walletDelete(id)               { return this._call('DELETE', `/wallets/${encodeURIComponent(id)}`); }
	async walletCode(body)               { return this._call('POST', '/wallets/code', { body }); }
	async walletValidate(body)           { return this._call('POST', '/wallets/validate', { body }); }

	async withdrawalCalculate(query)     { return this._call('GET', '/withdrawals/calculate', { query }); }
	async withdrawalCreate(body)         { return this._call('POST', '/withdrawals', { body }); }

	async invoiceDetail(id)              { return this._call('GET', `/invoices/${encodeURIComponent(id)}`); }
	async invoiceTopUp(body)             { return this._call('POST', '/invoices/top_up', { body }); }
	async invoiceTopUpCalculate(query)   { return this._call('GET', '/invoices/top_up/calculate', { query }); }

	async ledgerList(query)              { return this._call('GET', '/ledger_items', { query }); }
	async ledgerDetail(id)               { return this._call('GET', `/ledger_items/${encodeURIComponent(id)}`); }

	async summpaysList(query)            { return this._call('GET', '/summpays/list', { query }); }
	async summpaysCreate(body)           { return this._call('POST', '/summpays', { body }); }
	async summpaysCategories()           { return this._call('GET', '/summpays/categories'); }
	async summpaysCategoryDetail(id)     { return this._call('GET', `/summpays/categories/${encodeURIComponent(id)}`); }
	async summpaysTableView(query)       { return this._call('GET', '/summpays/table_view', { query }); }

	async reviewsList(query)             { return this._call('GET', '/reviews', { query }); }

	async rawCall(method, endpoint, opts = {}) {
		return this._call(method.toUpperCase(), endpoint, opts);
	}
}

let singleton = null;
function getClient() {
	if (!singleton) singleton = new GGselClient();
	return singleton;
}

module.exports = { GGselClient, getClient, HOST, API_BASE };
