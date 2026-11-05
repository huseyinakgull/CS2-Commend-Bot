const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { GamesatisBrowser } = require('./lib/browser');
const { login, isLoggedIn } = require('./lib/auth');
const { pollOnce } = require('./lib/orders');
const orderState = require('./lib/order-state');

async function cmdLogin() {
	const email = process.env.GAMESATIS_EMAIL;
	const password = process.env.GAMESATIS_PASSWORD;
	if (!email || !password) {
		console.error('HATA: .env içinde GAMESATIS_EMAIL ve GAMESATIS_PASSWORD tanımlı olmalı');
		process.exit(1);
	}

	const br = new GamesatisBrowser();
	try {
		const page = await br.launch();
		if (await isLoggedIn(page)) {
			console.log('✓ Zaten giriş yapılmış — yeni login gerekmiyor');
			await br.saveState();
			return;
		}
		await login(page, { email, password });
		await br.saveState();
		console.log('✓ Login tamam, storage state kaydedildi (oturum kalıcı)');
	} catch (err) {
		console.error('✗ Login hatası:', err.message);
		try { await br.screenshot('login-error.png', { fullPage: true }); console.error('  → screenshot: gamesatis-automation/screenshots/login-error.png'); } catch {}
		process.exit(2);
	} finally {
		await br.close();
	}
}

async function cmdLoginManual() {
	const br = new GamesatisBrowser();
	try {
		const page = await br.launch();
		console.log('\n══════════════════════════════════════════════════════════');
		console.log('  MANUEL LOGIN MODE');
		console.log('  Browser açıldı. Kendi elinle giriş formunu doldur.');
		console.log('  Captcha + email + password + SMS — hepsini sen gir.');
		console.log('  Login başarılı olduğunda terminale dönüp ENTER tuşuna bas.');
		console.log('══════════════════════════════════════════════════════════\n');

		await page.goto('https://www.gamesatis.com/giris-yap', { waitUntil: 'domcontentloaded' });

		await new Promise(resolve => {
			process.stdin.once('data', () => resolve());
			console.log('>>> ENTER tuşuna bas (login yaptıktan sonra) <<<');
		});

		const ok = await isLoggedIn(page);
		if (!ok) {
			console.log('✗ Hâlâ login sayfasında, ya tam giriş yapılmadı ya da session save edilemedi.');
			process.exit(1);
		}
		await br.saveState();
		console.log('✓ Login OK + storage state kaydedildi (oturum kalıcı)');
	} finally {
		await br.close();
	}
}

async function cmdCheck() {
	const br = new GamesatisBrowser();
	try {
		const page = await br.launch();
		const ok = await isLoggedIn(page);
		console.log(ok ? '✓ Session aktif' : '✗ Session yok / expired');
		process.exit(ok ? 0 : 1);
	} finally {
		await br.close();
	}
}

async function cmdPollOnce() {
	const br = new GamesatisBrowser();
	try {
		const page = await br.launch();
		if (!await isLoggedIn(page)) {
			console.log('✗ Session yok — önce login yap');
			process.exit(1);
		}
		const results = await pollOnce(page);
		console.log(`\n✓ Poll tamam: ${results.length} sipariş işlendi`);
		results.forEach(r => console.log(`  #${r.orderId} → ${r.success ? '✓ ' + (r.code || 'skip') : '✗ ' + r.error}`));
	} finally {
		await br.close();
	}
}

async function cmdStats() {
	const stats = orderState.getStats();
	console.log('Gamesatis Order Stats:');
	console.log(`  Toplam işlenen: ${stats.totalProcessed}`);
	console.log(`  Mesaj gönderildi: ${stats.messageSent}`);
	console.log(`  Teslim edildi: ${stats.delivered}`);
	console.log(`  Hata olan: ${stats.failed}`);
	console.log(`  Son poll: ${stats.lastPoll || '(hiç)'}`);
	const recent = orderState.listProcessed(10);
	if (recent.length) {
		console.log('\nSon 10:');
		recent.forEach(o => console.log(`  #${o.orderId} ${o.code || '(no code)'} ${o.delivered ? '✓' : '✗'} ${o.error || ''}`));
	}
}

async function cmdPollLoop() {
	const intervalSec = parseInt(process.env.GAMESATIS_POLL_INTERVAL_SEC || '60', 10);
	console.log(`Poll loop başladı (${intervalSec}s aralıkla, Ctrl+C ile çık)`);
	const br = new GamesatisBrowser();
	const page = await br.launch();
	if (!await isLoggedIn(page)) {
		console.log('✗ Session yok — önce login yap');
		await br.close();
		process.exit(1);
	}
	let running = false;
	const tick = async () => {
		if (running) return;
		running = true;
		try {
			const results = await pollOnce(page);
			if (results.length) console.log(`[${new Date().toISOString()}] ${results.length} sipariş işlendi`);
		} catch (err) {
			console.error(`[poll] hata: ${err.message}`);
		} finally {
			running = false;
		}
	};
	await tick();
	setInterval(tick, intervalSec * 1000);

	process.on('SIGINT', async () => {
		console.log('\nKapatılıyor...');
		await br.close();
		process.exit(0);
	});
}

const cmd = process.argv[2];
(async () => {
	switch (cmd) {
		case 'login': await cmdLogin(); break;
		case 'login-manual': await cmdLoginManual(); break;
		case 'check': await cmdCheck(); break;
		case 'poll':  await cmdPollOnce(); break;
		case 'loop':  await cmdPollLoop(); break;
		case 'stats': await cmdStats(); break;
		default:
			console.log('Kullanım: node gamesatis-automation/index.js <login|check|poll|loop|stats>');
			process.exit(1);
	}
})();
