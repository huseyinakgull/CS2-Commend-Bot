const HOME_URL = 'https://hesap.com.tr/';
const LOGIN_URL = 'https://hesap.com.tr/login';
const ILANLARIM_URL = 'https://hesap.com.tr/p/ilanlarim';
const SATTIGIM_URL = 'https://hesap.com.tr/p/sattigim-ilanlar';
const PASIF_URL = 'https://hesap.com.tr/p/pasifilanlarim';

async function isLoggedIn(page) {
	try {
		const resp = await page.goto(ILANLARIM_URL, {
			waitUntil: 'domcontentloaded',
			timeout: 25000
		});
		await page.waitForTimeout(1500);

		const finalUrl = page.url();
		const status = resp?.status?.() ?? 0;

		if (finalUrl.includes('/login') || finalUrl.includes('/giris')) return false;
		if (status === 401 || status === 403) return false;

		return finalUrl.includes('/p/');
	} catch (err) {
		console.warn('[hesap-auth] isLoggedIn hata:', err.message);
		return false;
	}
}

async function manualLogin(browser, opts = {}) {
	const timeoutMs = opts.timeoutMs || 5 * 60 * 1000;
	const page = browser.page;

	console.log('[hesap-auth] /login sayfasına gidiliyor — kullanıcının Google ile giriş yapması bekleniyor');
	await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });

	const startedAt = Date.now();
	let lastUrl = page.url();
	while (Date.now() - startedAt < timeoutMs) {
		await page.waitForTimeout(3000);
		const currentUrl = page.url();
		if (currentUrl !== lastUrl) {
			console.log(`[hesap-auth] URL değişti: ${currentUrl}`);
			lastUrl = currentUrl;
		}
		if (currentUrl.includes('/p/')) {
			console.log('[hesap-auth] ✓ login başarılı — panel açıldı');
			await browser.saveState();
			return { ok: true, url: currentUrl };
		}
	}

	console.warn('[hesap-auth] manuel login timeout (5dk)');
	return { ok: false, error: 'manual_login_timeout' };
}

module.exports = {
	HOME_URL, LOGIN_URL, ILANLARIM_URL, SATTIGIM_URL, PASIF_URL,
	isLoggedIn, manualLogin
};
