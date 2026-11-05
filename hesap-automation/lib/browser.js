const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const STORAGE_STATE_PATH = path.join(__dirname, '..', 'data', 'storage-state.json');
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'screenshots');

for (const d of [path.dirname(STORAGE_STATE_PATH), SCREENSHOTS_DIR]) {
	if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

class HesapBrowser {
	constructor(opts = {}) {
		this.headless = opts.headless ?? (process.env.HESAP_HEADLESS === 'true');
		this.userAgent = opts.userAgent ||
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
			'(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
		this.proxy = opts.proxy || null;
		this.browser = null;
		this.context = null;
		this.page = null;
	}

	async launch() {
		const launchOpts = {
			headless: this.headless,
			args: [
				'--disable-blink-features=AutomationControlled',
				'--no-sandbox',
				'--disable-features=IsolateOrigins,site-per-process'
			]
		};

		if (this.proxy) {
			launchOpts.proxy = this.proxy;
			console.log(`[hesap-browser] proxy aktif: ${this.proxy.server}`);
		} else {
			console.log('[hesap-browser] ⚠ proxy YOK — hesap.com.tr 403 verebilir');
		}

		this.browser = await chromium.launch(launchOpts);

		const contextOpts = {
			userAgent: this.userAgent,
			viewport: { width: 1366, height: 768 },
			locale: 'tr-TR',
			timezoneId: 'Europe/Istanbul',
			extraHTTPHeaders: {
				'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8'
			}
		};

		if (fs.existsSync(STORAGE_STATE_PATH)) {
			contextOpts.storageState = STORAGE_STATE_PATH;
			console.log('[hesap-browser] storage state diskten yüklendi');
		}

		this.context = await this.browser.newContext(contextOpts);

		await this.context.addInitScript(() => {
			Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
			Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
			Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR', 'tr', 'en'] });
		});

		this.page = await this.context.newPage();
		this.page.setDefaultTimeout(30000);

		return this.page;
	}

	async saveState() {
		if (!this.context) return;
		await this.context.storageState({ path: STORAGE_STATE_PATH });
		console.log('[hesap-browser] storage state diske kaydedildi');
	}

	async screenshot(filename, opts = {}) {
		if (!this.page) throw new Error('page not launched');
		const fpath = path.join(SCREENSHOTS_DIR, filename);
		await this.page.screenshot({ path: fpath, ...opts });
		return fpath;
	}

	async screenshotElement(selector) {
		if (!this.page) throw new Error('page not launched');
		const el = await this.page.$(selector);
		if (!el) throw new Error(`element not found: ${selector}`);
		return await el.screenshot();
	}

	async close() {
		try { await this.saveState(); } catch {}
		try { if (this.context) await this.context.close(); } catch {}
		try { if (this.browser) await this.browser.close(); } catch {}
		this.browser = null;
		this.context = null;
		this.page = null;
	}
}

module.exports = { HesapBrowser, STORAGE_STATE_PATH, SCREENSHOTS_DIR };
