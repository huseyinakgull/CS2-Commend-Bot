const fetch = global.fetch || require('node-fetch');

const BASE_URL = process.env.CSCOMMENDS_BASE_URL || 'http://localhost:3000';
const TOKEN = process.env.CSCOMMENDS_INTERNAL_TOKEN || '';

if (!TOKEN) {
	console.warn('[hitl-client] UYARI: CSCOMMENDS_INTERNAL_TOKEN .env\'de yok — istekler 401 alacak');
}

function authHeaders() {
	return {
		'Content-Type': 'application/json',
		'X-Internal-Token': TOKEN
	};
}

async function ask(opts) {
	const { type, source, prompt, screenshot, expiresInSec = 600, metadata } = opts;

	let screenshotData = null;
	if (screenshot) {
		if (Buffer.isBuffer(screenshot)) {
			screenshotData = `data:image/png;base64,${screenshot.toString('base64')}`;
		} else if (typeof screenshot === 'string' && screenshot.startsWith('data:')) {
			screenshotData = screenshot;
		}
	}

	const createRes = await fetch(`${BASE_URL}/api/hitl/internal/create`, {
		method: 'POST',
		headers: authHeaders(),
		body: JSON.stringify({ type, source, prompt, screenshot: screenshotData, expiresInSec, metadata })
	});
	if (!createRes.ok) {
		const text = await createRes.text();
		throw new Error(`HITL create failed (${createRes.status}): ${text}`);
	}
	const { id, expiresAt } = await createRes.json();
	console.log(`[hitl] challenge #${id} oluşturuldu (${type}/${source}), expires ${expiresAt}`);

	const startedAt = Date.now();
	const overallTimeoutMs = (expiresInSec + 10) * 1000;

	while (Date.now() - startedAt < overallTimeoutMs) {
		const pollRes = await fetch(`${BASE_URL}/api/hitl/internal/poll/${id}`, {
			headers: authHeaders()
		});
		if (!pollRes.ok) {
			throw new Error(`HITL poll failed (${pollRes.status})`);
		}
		const data = await pollRes.json();

		if (data.status === 'resolved') {
			console.log(`[hitl] challenge #${id} cevaplandı: "${data.answer.slice(0, 20)}..."`);
			return data.answer;
		}
		if (data.status === 'cancelled') {
			throw new Error(`HITL #${id} admin tarafından iptal edildi`);
		}
		if (data.status === 'expired') {
			throw new Error(`HITL #${id} süresi doldu (admin cevap vermedi)`);
		}
	}

	try {
		await fetch(`${BASE_URL}/api/hitl/internal/cancel/${id}`, {
			method: 'POST',
			headers: authHeaders()
		});
	} catch {}
	throw new Error(`HITL #${id} timeout (${overallTimeoutMs}ms)`);
}

module.exports = {
	ask,
	askForCaptcha: (opts) => ask({ type: 'captcha', ...opts }),
	askForSms:     (opts) => ask({ type: 'sms', ...opts }),
	askFor2FA:     (opts) => ask({ type: '2fa', ...opts }),
	askGeneric:    (opts) => ask({ type: 'generic', ...opts })
};
