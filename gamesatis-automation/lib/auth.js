const hitl = require('./hitl-client');

const GAMESATIS_LOGIN_URL = 'https://www.gamesatis.com/giris-yap';
const GAMESATIS_HOME_URL  = 'https://www.gamesatis.com/';
const GAMESATIS_ACCOUNT_URL = 'https://www.gamesatis.com/satislarim';

async function isLoggedIn(page) {
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			await page.goto(GAMESATIS_ACCOUNT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
			const url = page.url();
			if (/\/(giris-yap|giris|login)(\b|\/|\?|$)/.test(url)) return false;
			return true;
		} catch (err) {
			if (attempt === 1) {
				console.warn(`[auth] isLoggedIn timeout (deneme ${attempt}), 3s sonra tekrar...`);
				await page.waitForTimeout(3000);
				continue;
			}
			return false;
		}
	}
	return false;
}

async function login(page, creds) {
	const { email, password } = creds;
	if (!email || !password) throw new Error('email + password gerekli');

	console.log('[auth] login sayfasına gidiliyor: ' + GAMESATIS_LOGIN_URL);
	await page.goto(GAMESATIS_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

	await page.waitForSelector('input#email, input[name="email"]', { timeout: 15000 });

	console.log('[auth] email + password yazılıyor...');
	await page.fill('input#email, input[name="email"]', email);
	await page.fill('input#password, input[name="password"]', password);

	const captchaInput = await page.$('input[name="captcha_code"]');
	let captchaSuccess = false;
	let lastCaptchaError = null;
	if (captchaInput) {
		const MAX_CAPTCHA_RETRY = 3;
		for (let attempt = 1; attempt <= MAX_CAPTCHA_RETRY; attempt++) {
			console.log(`[auth] captcha attempt ${attempt}/${MAX_CAPTCHA_RETRY}`);

			try {
				for (let i = 0; i < 5; i++) {
					const closeBtn = await page.$('.gs-popup .gs-popup-close, .gs-popup button[data-close], .gs-popup button:has-text("Devam Et"), .gs-popup button:has-text("Tamam")');
					if (!closeBtn) break;
					console.log(`[auth] gs-popup kapatılıyor (${i + 1})`);
					await closeBtn.click({ force: true }).catch(() => {});
					await page.waitForTimeout(700);
				}
			} catch {}

			try {
				await page.waitForSelector('.input-with-captcha img', { timeout: 5000 });
				const oldSrc = await page.locator('.input-with-captcha img').first().evaluate(el => el.src);
				const refreshBtn = await page.$('.input-with-captcha button');
				if (refreshBtn) {
					await refreshBtn.click({ force: true });
					console.log('[auth] captcha refresh tıklandı, image src değişimi bekleniyor...');
					await page.waitForFunction(
						(old) => {
							const el = document.querySelector('.input-with-captcha img');
							return el && el.src && el.src !== old && el.src.length > 100;
						},
						oldSrc,
						{ timeout: 5000 }
					).catch(() => console.log('[auth] img.src değişimi timeout — eski olabilir'));
					await page.waitForTimeout(500);
				}
			} catch (err) {
				console.log(`[auth] captcha refresh hatası: ${err.message}`);
			}

			let captchaImgBuf = null;
			try {
				captchaImgBuf = await page.locator('.input-with-captcha img').first().screenshot();
				console.log(`[auth] captcha image (${captchaImgBuf.length} bytes)`);
			} catch (err) {
				console.log(`[auth] captcha screenshot hatası: ${err.message}`);
			}
			if (captchaImgBuf) {
				try {
					const sharp = require('sharp');
					captchaImgBuf = await sharp(captchaImgBuf).resize({ width: 600, kernel: 'nearest' }).sharpen().toBuffer();
				} catch (err) { console.log(`[auth] sharp upscale fail: ${err.message}`); }
			}

			let answer;
			try {
				answer = await hitl.askForCaptcha({
					source: 'gamesatis_login',
					prompt: `Gamesatis captcha (attempt ${attempt}/${MAX_CAPTCHA_RETRY}) — resimdeki kodu yaz, hızlıca! (~30s'de expire olur)`,
					screenshot: captchaImgBuf,
					expiresInSec: 600
				});
			} catch (err) {
				console.log(`[auth] HITL fail attempt ${attempt}: ${err.message}`);
				lastCaptchaError = err;
				continue;
			}

			await page.fill('input[name="captcha_code"]', answer.trim());
			console.log(`[auth] captcha cevap dolduruldu: "${answer.trim()}"`);

			try {
				const trustCb = await page.$('input#trust_machine, input[name="trust_machine"]');
				if (trustCb && !(await trustCb.isChecked())) {
					await trustCb.check({ force: true }).catch(() => page.click('label[for="trust_machine"]').catch(() => {}));
				}
			} catch {}

			console.log('[auth] submit ediliyor...');
			const submitBtn = await page.$('button.btn.btn-blue:has-text("Giriş Yap"), button[type="submit"]:has-text("Giriş Yap")');
			if (submitBtn) {
				await Promise.all([
					page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
					submitBtn.click({ force: true }).catch(() => page.locator('input[name="captcha_code"]').press('Enter'))
				]);
			} else {
				await page.locator('input[name="captcha_code"]').press('Enter');
				await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
			}

			await page.waitForTimeout(3000);

			try {
				const fs = require('fs');
				const path = require('path');
				const ssDir = path.join(__dirname, '..', 'screenshots');
				if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true });
				const ssPath = path.join(ssDir, `login-attempt${attempt}-${Date.now()}.png`);
				await page.screenshot({ path: ssPath, fullPage: true });
				console.log(`[auth] post-submit screenshot: ${ssPath}`);
			} catch {}

			let captchaWrong = false;
			try {
				const popup = await page.$('.gs-popup');
				if (popup) {
					const popupText = (await popup.innerText().catch(() => '')).toLowerCase();
					if (/güvenlik kod|captcha|kod hatalı|kod yanlış|hatalı girdiniz/i.test(popupText)) {
						captchaWrong = true;
						console.log(`[auth] popup CAPTCHA HATA tespit: "${popupText.slice(0, 60)}"`);
					} else {
						console.log(`[auth] popup farklı mesaj: "${popupText.slice(0, 80)}"`);
					}
					const closeBtn = await page.$('.gs-popup .gs-popup-close, .gs-popup button[data-close], .gs-popup button:has-text("Devam Et"), .gs-popup button:has-text("Tamam")');
					if (closeBtn) await closeBtn.click({ force: true }).catch(() => {});
					await page.waitForTimeout(500);
				}
			} catch {}

			const url = page.url();
			if (!/\/(giris-yap|giris|login)\b/.test(url)) {
				console.log('[auth] login sayfasından çıkıldı — captcha OK');
				captchaSuccess = true;
				break;
			}

			const smsSelectors = [
				'input[name="sms_code"]', 'input[name="sms"]', 'input[name="otp"]',
				'input[name="verification_code"]', 'input[name="kod"]',
				'input[autocomplete="one-time-code"]',
				'input[inputmode="numeric"][maxlength="6"]',
				'input[type="text"][maxlength="6"]:not([name="captcha_code"])',
				'input[type="number"][maxlength="6"]:not([name="captcha_code"])',
				'input[placeholder*="sms" i]:not([name="captcha_code"])',
				'input[placeholder*="OTP" i]:not([name="captcha_code"])',
				'input[placeholder*="telefon" i]:not([name="captcha_code"])'
			];
			let smsFound = false;
			for (const sel of smsSelectors) {
				const el = await page.$(sel).catch(() => null);
				if (el && await el.isVisible().catch(() => false)) {
					console.log(`[auth] SMS input tespit: ${sel} — captcha OK, SMS aşamasına geçildi`);
					smsFound = true;
					break;
				}
			}
			if (smsFound) {
				captchaSuccess = true;
				break;
			}

			if (captchaWrong) {
				console.log(`[auth] captcha attempt ${attempt} fail — popup "kod hatalı", retry`);
				continue;
			}

			console.log(`[auth] captcha attempt ${attempt} belirsiz — 5s daha bekleniyor...`);
			await page.waitForTimeout(5000);
			for (const sel of smsSelectors) {
				const el = await page.$(sel).catch(() => null);
				if (el && await el.isVisible().catch(() => false)) {
					smsFound = true;
					break;
				}
			}
			if (smsFound) {
				console.log('[auth] SMS input GEÇİKMELİ tespit — captcha OK');
				captchaSuccess = true;
				break;
			}
			console.log(`[auth] captcha attempt ${attempt} fail — net işaret yok, retry`);
		}

		if (!captchaSuccess) {
			throw new Error(`Captcha ${MAX_CAPTCHA_RETRY} denemede de başarısız${lastCaptchaError ? ': ' + lastCaptchaError.message : ''}`);
		}
	} else {
		console.log('[auth] captcha alanı yok, doğrudan submit');
		const submitBtn = await page.$('button.btn.btn-blue:has-text("Giriş Yap"), button[type="submit"]:has-text("Giriş Yap")');
		if (submitBtn) {
			await Promise.all([
				page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
				submitBtn.click()
			]);
		} else {
			await page.keyboard.press('Enter');
			await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
		}
	}

	const smsInputSel = await firstAvailable(page, [
		'input[name="sms_code"]',
		'input[name="sms"]',
		'input[name="otp"]',
		'input[name="verification_code"]',
		'input[name="kod"]',
		'input[autocomplete="one-time-code"]',
		'input[inputmode="numeric"][maxlength="6"]',
		'input[type="text"][maxlength="6"]:not([name="captcha_code"])',
		'input[placeholder*="sms" i]:not([name="captcha_code"])',
		'input[placeholder*="telefon" i]:not([name="captcha_code"])'
	], 8000);

	if (smsInputSel) {
		console.log(`[auth] SMS doğrulama bekleniyor (${smsInputSel})`);
		const smsCode = await hitl.askForSms({
			source: 'gamesatis_login',
			prompt: 'Gamesatis SMS kodu — telefonuna gelen 6 haneli kodu yaz',
			expiresInSec: 300
		});

		await page.fill(smsInputSel, smsCode.trim());
		console.log(`[auth] SMS cevabı dolduruldu`);

		try {
			await page.locator(smsInputSel).focus();
			await page.keyboard.press('Enter');
			console.log('[auth] SMS form Enter ile submit edildi');
		} catch (err) {
			console.log('[auth] Enter submit fail, button click force deneniyor:', err.message);
			const submit2 = await firstAvailable(page, [
				'button.btn.btn-blue',
				'button[type="submit"]'
			]);
			if (submit2) {
				await page.click(submit2, { force: true }).catch(e => console.log('[auth] force click fail:', e.message));
			}
		}
		await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
	}

	await page.waitForTimeout(3000);
	const finalUrl = page.url();
	console.log(`[auth] login sonrası URL: ${finalUrl}`);

	if (finalUrl.includes('giris-yap') || finalUrl.includes('login')) {
		console.log('[auth] URL hâlâ login\'de — session check ile doğruluyoruz...');
		const ok = await isLoggedIn(page);
		if (!ok) {
			const errBlock = await page.textContent('.alert-danger, .alert-error, .error, [class*="hata" i]').catch(() => null);
			throw new Error(`Login başarısız${errBlock ? ': ' + errBlock.trim().slice(0, 200) : ' (session aktif değil)'}`);
		}
		console.log('[auth] session aktif ✓ (URL gecikmesi yanıltıcıydı)');
	}

	console.log('[auth] login başarılı ✓');
	return true;
}

async function firstAvailable(page, selectors, timeoutMs = 2000) {
	for (const sel of selectors) {
		try {
			await page.waitForSelector(sel, { timeout: timeoutMs, state: 'visible' });
			return sel;
		} catch {}
	}
	return null;
}

module.exports = { login, isLoggedIn, GAMESATIS_LOGIN_URL, GAMESATIS_ACCOUNT_URL };
