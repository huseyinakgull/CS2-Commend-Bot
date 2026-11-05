const crypto = require('crypto');
const https = require('https');

const API_BASE = 'api.nowpayments.io';
const API_PATH_PREFIX = '/v1';

function _request(method, path, bodyObj, apiKey) {
	return new Promise((resolve, reject) => {
		const body = bodyObj ? JSON.stringify(bodyObj) : null;
		const req = https.request({
			method,
			hostname: API_BASE,
			path: API_PATH_PREFIX + path,
			headers: {
				'x-api-key': apiKey,
				'Content-Type': 'application/json',
				...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
			},
			timeout: 15000
		}, res => {
			let buf = '';
			res.on('data', d => buf += d);
			res.on('end', () => {
				let parsed;
				try { parsed = JSON.parse(buf); } catch { parsed = { raw: buf }; }
				if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
				else reject(new Error(`NowPayments ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 300)}`));
			});
		});
		req.on('error', reject);
		req.on('timeout', () => { try { req.destroy(); } catch {} reject(new Error('NowPayments request timeout')); });
		if (body) req.write(body);
		req.end();
	});
}

async function createInvoice(opts, apiKey) {
	const payload = {
		price_amount: opts.priceAmount,
		price_currency: opts.priceCurrency || 'usd',
		order_id: String(opts.orderId),
		order_description: opts.orderDescription || 'CS Commends balance top-up',
		ipn_callback_url: opts.ipnCallbackUrl,
		success_url: opts.successUrl,
		cancel_url: opts.cancelUrl,
		is_fixed_rate: opts.isFixedRate !== false,
		is_fee_paid_by_user: opts.isFeePaidByUser !== false
	};
	if (opts.payCurrency) payload.pay_currency = opts.payCurrency;

	return _request('POST', '/invoice', payload, apiKey);
}

async function getPaymentStatus(paymentId, apiKey) {
	return _request('GET', `/payment/${paymentId}`, null, apiKey);
}

function verifyWebhook(payloadObj, signatureHeader, ipnSecret) {
	if (!signatureHeader || !ipnSecret) return false;
	try {
		const sorted = _sortDeep(payloadObj);
		const canonical = JSON.stringify(sorted);
		const computed = crypto.createHmac('sha512', ipnSecret).update(canonical).digest('hex');
		const a = Buffer.from(computed, 'utf8');
		const b = Buffer.from(String(signatureHeader), 'utf8');
		if (a.length !== b.length) return false;
		return crypto.timingSafeEqual(a, b);
	} catch {
		return false;
	}
}

function _sortDeep(value) {
	if (Array.isArray(value)) return value.map(_sortDeep);
	if (value && typeof value === 'object') {
		const out = {};
		for (const k of Object.keys(value).sort()) out[k] = _sortDeep(value[k]);
		return out;
	}
	return value;
}

module.exports = {
	createInvoice,
	getPaymentStatus,
	verifyWebhook,
	_sortDeep
};
