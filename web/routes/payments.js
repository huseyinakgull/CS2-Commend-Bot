const express = require('express');
const crypto = require('crypto');
const db = require('../database');
const config = require('../config.json');
const np = require('../lib/nowpayments');
const { rateLimit } = require('../middleware/auth');

const router = express.Router();

const PACKAGES = [
	{ id: 'test',       name: 'Test',        balance: 20,   priceUsd: 0.50,  perCommendUsd: 0.0250, popular: false, isTest: true },
	{ id: 'starter',    name: 'Baslangic',   balance: 100,  priceUsd: 1.99,  perCommendUsd: 0.0199, popular: false },
	{ id: 'standart',   name: 'Standart',    balance: 300,  priceUsd: 4.99,  perCommendUsd: 0.0166, popular: true  },
	{ id: 'pro',        name: 'Pro',         balance: 600,  priceUsd: 8.99,  perCommendUsd: 0.0150, popular: false, savePct: 25 },
	{ id: 'mega',       name: 'Mega',        balance: 1500, priceUsd: 19.99, perCommendUsd: 0.0133, popular: false, savePct: 33 },
	{ id: 'enterprise', name: 'Kurumsal',    balance: 5000, priceUsd: 59.99, perCommendUsd: 0.0120, popular: false, savePct: 40 },
];

function _generateCode(balance, productType = 'commend', resellerId = null) {
	function makeCode() {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
		const seg = (n) => Array.from({length: n}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
		return `${seg(4)}-${seg(4)}-${seg(4)}`;
	}
	for (let i = 0; i < 3; i++) {
		const code = makeCode();
		try {
			const ins = db.prepare(`
				INSERT INTO codes (code, balance, initial_balance, product_type, reseller_id)
				VALUES (?, ?, ?, ?, ?)
			`).run(code, balance, balance, productType, resellerId);
			return { id: ins.lastInsertRowid, code, balance, productType };
		} catch (e) {
			if (!/UNIQUE/.test(e.message)) throw e;
		}
	}
	throw new Error('code_generation_failed_after_3_attempts');
}

function _verifyAccessToken(storedToken, providedToken) {
	if (!storedToken || !providedToken) return false;
	const a = Buffer.from(String(storedToken), 'utf8');
	const b = Buffer.from(String(providedToken), 'utf8');
	if (a.length !== b.length) return false;
	try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

router.get('/packages', (req, res) => {
	res.json({ packages: PACKAGES });
});

router.post('/nowpayments/checkout',
	rateLimit(15, 60_000, 'pay-checkout'),
	async (req, res) => {
		try {
			const apiKey = process.env.NOWPAYMENTS_API_KEY || config.nowpaymentsApiKey;
			if (!apiKey) return res.status(503).json({ error: 'payment_provider_not_configured' });

			const { packageId, contactEmail } = req.body || {};
			const pkg = PACKAGES.find(p => p.id === packageId);
			if (!pkg) return res.status(400).json({ error: 'invalid_package' });

			const cleanEmail = (typeof contactEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim()))
				? contactEmail.trim().slice(0, 200)
				: null;

			const accessToken = crypto.randomBytes(32).toString('hex');

			const ins = db.prepare(`
				INSERT INTO payments (provider, provider_invoice_id, package_id, balance_credit, price_amount, price_currency, contact_email, status, ip, user_agent, access_token)
				VALUES ('nowpayments', ?, ?, ?, ?, 'usd', ?, 'created', ?, ?, ?)
			`).run(
				`pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				pkg.id,
				pkg.balance,
				pkg.priceUsd,
				cleanEmail,
				req.ip || null,
				(req.headers['user-agent'] || '').slice(0, 200),
				accessToken
			);
			const orderId = ins.lastInsertRowid;

			const baseUrl = (config.publicBaseUrl || `https://${req.get('host')}`).replace(/\/$/, '');

			let invoice;
			try {
				invoice = await np.createInvoice({
					priceAmount: pkg.priceUsd,
					priceCurrency: 'usd',
					orderId: String(orderId),
					orderDescription: `CS Commends — ${pkg.name} paketi (${pkg.balance} commend)`,
					ipnCallbackUrl: `${baseUrl}/api/payments/nowpayments/ipn`,
					successUrl: `${baseUrl}/odeme-sonuc?order=${orderId}&token=${accessToken}`,
					cancelUrl: `${baseUrl}/odeme-iptal?order=${orderId}`
				}, apiKey);
			} catch (e) {
				db.prepare(`UPDATE payments SET status = 'failed', updated_at = datetime('now') WHERE id = ?`).run(orderId);
				console.error('[payments] nowpayments createInvoice err:', e.message);
				return res.status(502).json({ error: 'provider_error', message: e.message });
			}

			db.prepare(`
				UPDATE payments
				SET provider_invoice_id = ?, status = 'waiting', updated_at = datetime('now')
				WHERE id = ?
			`).run(String(invoice.id), orderId);

			if (db.addAuditLog) {
				db.addAuditLog('payment_invoice_created', 'public', orderId, 'payment',
					{ provider: 'nowpayments', invoiceId: invoice.id, packageId: pkg.id, priceUsd: pkg.priceUsd, email: cleanEmail || null }, req.ip);
			}

			res.json({
				ok: true,
				orderId,
				accessToken,
				invoiceUrl: invoice.invoice_url,
				package: pkg
			});
		} catch (err) {
			console.error('[payments] checkout err:', err);
			res.status(500).json({ error: 'internal_error', message: err.message });
		}
	}
);

router.post('/nowpayments/ipn', express.json({ limit: '64kb' }), (req, res) => {
	try {
		const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET || config.nowpaymentsIpnSecret;
		const sigHeader = req.headers['x-nowpayments-sig'];

		if (!ipnSecret) {
			console.error('[payments] webhook: IPN secret not configured — IGNORING');
			return res.status(503).json({ error: 'webhook_secret_not_configured' });
		}

		const body = req.body || {};
		const isValid = np.verifyWebhook(body, sigHeader, ipnSecret);
		if (!isValid) {
			console.warn('[payments] webhook: invalid signature, payload:', JSON.stringify(body).slice(0, 200));
			return res.status(401).json({ error: 'invalid_signature' });
		}

		const invoiceId = String(body.invoice_id || '');
		const paymentId = body.payment_id ? String(body.payment_id) : null;
		const status = (body.payment_status || body.status || '').toLowerCase();
		const payAmount = body.pay_amount ? Number(body.pay_amount) : null;
		const payCurrency = body.pay_currency || null;
		const orderIdFromBody = body.order_id ? Number(body.order_id) : null;

		let row = orderIdFromBody
			? db.prepare(`SELECT * FROM payments WHERE id = ? AND provider = 'nowpayments'`).get(orderIdFromBody)
			: null;
		if (!row && invoiceId) {
			row = db.prepare(`SELECT * FROM payments WHERE provider = 'nowpayments' AND provider_invoice_id = ?`).get(invoiceId);
		}

		if (!row) {
			console.warn('[payments] webhook: unknown order — orderId:', orderIdFromBody, 'invoiceId:', invoiceId);
			return res.status(202).json({ ok: true, note: 'unknown_order' });
		}

		const FINAL_SUCCESS = ['finished', 'confirmed', 'sending'];
		const FINAL_FAIL = ['failed', 'refunded', 'expired'];

		const txn = db.transaction(() => {
			db.prepare(`
				UPDATE payments
				SET status = ?,
				    pay_currency = COALESCE(?, pay_currency),
				    pay_amount   = COALESCE(?, pay_amount),
				    provider_payment_id = COALESCE(?, provider_payment_id),
				    webhook_payload = ?,
				    updated_at = datetime('now'),
				    completed_at = CASE WHEN ? IN ('finished','failed','refunded','expired') THEN datetime('now') ELSE completed_at END
				WHERE id = ?
			`).run(status || row.status, payCurrency, payAmount, paymentId, JSON.stringify(body).slice(0, 4000), status, row.id);

			if (FINAL_SUCCESS.includes(status) && row.code_generated === 0) {
				const codeRow = _generateCode(row.balance_credit, 'commend', null);
				db.prepare(`
					UPDATE payments
					SET generated_code_id = ?, code_generated = 1
					WHERE id = ?
				`).run(codeRow.id, row.id);
				console.log(`[payments] OK payment #${row.id} -> kod uretildi: ${codeRow.code} (${codeRow.balance} bakiye)`);
				if (db.addAuditLog) {
					db.addAuditLog('payment_code_generated', 'system', row.id, 'payment',
						{ codeId: codeRow.id, code: codeRow.code, balance: codeRow.balance, payAmount, payCurrency, email: row.contact_email }, req.ip);
				}
			} else if (FINAL_FAIL.includes(status)) {
				console.log(`[payments] FAIL payment #${row.id} ${status}`);
			}
		});
		txn();

		res.json({ ok: true });
	} catch (err) {
		console.error('[payments] webhook err:', err);
		res.status(500).json({ error: 'internal_error' });
	}
});

router.get('/order/:orderId',
	rateLimit(60, 60_000, 'pay-order-poll'),
	(req, res) => {
		const id = parseInt(req.params.orderId, 10);
		if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });

		const providedToken = (req.query.token || '').toString();
		if (!providedToken) return res.status(404).json({ error: 'order_not_found' });

		const row = db.prepare(`
			SELECT p.id, p.status, p.balance_credit, p.price_amount, p.price_currency,
			       p.pay_currency, p.pay_amount, p.code_generated, p.contact_email,
			       p.created_at, p.completed_at, p.package_id, p.access_token,
			       c.code as generated_code
			FROM payments p
			LEFT JOIN codes c ON c.id = p.generated_code_id
			WHERE p.id = ? AND p.provider = 'nowpayments'
		`).get(id);

		if (!row) return res.status(404).json({ error: 'order_not_found' });

		if (!_verifyAccessToken(row.access_token, providedToken)) {
			return res.status(404).json({ error: 'order_not_found' });
		}

		const pkg = PACKAGES.find(p => p.id === row.package_id);

		res.json({
			orderId: row.id,
			status: row.status,
			package: pkg,
			balance: row.balance_credit,
			priceAmount: row.price_amount,
			priceCurrency: row.price_currency,
			payAmount: row.pay_amount,
			payCurrency: row.pay_currency,
			isReady: row.code_generated === 1,
			code: row.code_generated === 1 ? row.generated_code : null,
			createdAt: row.created_at,
			completedAt: row.completed_at
		});
	}
);

module.exports = router;
