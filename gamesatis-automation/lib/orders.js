const SATISLARIM_URL = 'https://www.gamesatis.com/satislarim';
const ILANLARIM_URL  = 'https://www.gamesatis.com/ilanlarim';

const PRODUCT_REGEX = /cs2-ovgu-boost\/(\d+)-(\d+)-(\d+)-(\d+)/;

function parseProduct(url) {
	if (!url) return null;
	const m = String(url).match(PRODUCT_REGEX);
	if (!m) return null;
	return {
		type: 'commend',
		friendly: +m[1],
		teaching: +m[2],
		leader: +m[3],
		total: +m[4]
	};
}

function parseSteamProfile(url) {
	if (!url) return null;
	const id64 = url.match(/profiles\/(\d{15,20})/);
	if (id64) return { kind: 'id64', value: id64[1] };
	const vanity = url.match(/\/id\/([^\/\?#]+)/);
	if (vanity) return { kind: 'vanity', value: vanity[1] };
	return null;
}

async function listPendingOrders(page) {
	await page.goto(SATISLARIM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
	await page.waitForTimeout(2500);

	const orders = await page.evaluate(() => {
		const out = [];
		const containers = document.querySelectorAll('.user-panel-box, .item-detail.sale-detail');
		containers.forEach(row => {
			const buttons = Array.from(row.querySelectorAll('button'));
			const deliverBtn = buttons.find(b => (b.innerText || '').trim() === 'Teslim Ettim');
			if (!deliverBtn) return;

			const productA = row.querySelector('a[href*="cs2-ovgu-boost"]');
			const steamA = row.querySelector('a[href*="steamcommunity.com"]');
			if (!productA || !steamA) return;

			const contactBtn = buttons.find(b => (b.innerText || '').trim() === 'Alıcı ile İletişime Geç');

			const form = deliverBtn.closest('form');
			let orderId = null;
			let formAction = null;
			if (form) {
				formAction = form.action || form.getAttribute('action') || null;
				if (formAction) {
					const m = formAction.match(/\/(\d{4,})/);
					if (m) orderId = m[1];
				}
			}
			const allText = row.innerText.split('\n').map(s => s.trim()).filter(Boolean);

			const rowMarker = row.id || row.dataset.id || row.dataset.orderId || null;

			out.push({
				orderId,
				formAction,
				rowMarker,
				productUrl: productA.href,
				buyerSteamUrl: steamA.href,
				rowText: allText.slice(0, 12),
				rowOuterHTMLLen: row.outerHTML.length
			});
		});
		return out;
	});

	const enriched = orders.map(o => {
		const idMatch = o.rowText.find(t => /^#\d+/.test(t));
		const orderId = o.orderId || (idMatch ? idMatch.replace('#', '') : null);
		const dateLine = o.rowText.find(t => t.startsWith('Tarih:'));
		return {
			...o,
			orderId,
			orderDate: dateLine ? dateLine.replace('Tarih:', '').trim() : null,
			productLabel: o.rowText.find(t => /ÖVGÜ|COMMEND|HIZLI/i.test(t)) || null,
			product: parseProduct(o.productUrl),
			buyer: parseSteamProfile(o.buyerSteamUrl)
		};
	}).filter(o => o.product);

	const seen = new Map();
	for (const o of enriched) {
		const key = o.orderId || `${o.buyerSteamUrl}|${o.productUrl}|${o.orderDate}`;
		if (!seen.has(key)) seen.set(key, o);
	}
	return Array.from(seen.values());
}

async function sendMessageToBuyer(page, order, message) {
	if (!order.orderId) throw new Error('orderId zorunlu (yanlış müşteriye mesaj gitmesin)');
	await page.goto(SATISLARIM_URL, { waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(2000);

	const clicked = await page.evaluate(({ buyerSteam, orderId }) => {
		const orderTag = `#${orderId}`;
		const rows = document.querySelectorAll('.user-panel-box, .item-detail.sale-detail');
		for (const row of rows) {
			const text = row.innerText || '';
			if (!text.includes(orderTag)) continue;
			const hasSteam = !!row.querySelector(`a[href="${buyerSteam}"], a[href="${buyerSteam}/"]`);
			if (!hasSteam) continue;
			const contactBtn = Array.from(row.querySelectorAll('button'))
				.find(b => (b.innerText || '').trim() === 'Alıcı ile İletişime Geç');
			if (contactBtn) { contactBtn.click(); return true; }
		}
		return false;
	}, { buyerSteam: order.buyerSteamUrl, orderId: order.orderId });

	if (!clicked) {
		throw new Error(`Alıcı ile İletişime Geç butonu bulunamadı (#${order.orderId} + ${order.buyerSteamUrl})`);
	}

	await page.waitForURL(url => url.toString().includes('/mesajlarim?active_tab='), { timeout: 15000 });
	await page.waitForSelector('textarea[placeholder*="Mesajınızı"]', { timeout: 10000 });

	await page.fill('textarea[placeholder*="Mesajınızı"]', message);

	const sendBtn = await page.$('button:has-text("Gönder")');
	if (!sendBtn) throw new Error('"Gönder" butonu bulunamadı');
	await sendBtn.click();
	await page.waitForTimeout(2500);
	return true;
}

async function markDelivered(page, order) {
	if (!order.orderId) throw new Error('orderId zorunlu (yanlış sipariş teslim edilmesin)');
	await page.goto(SATISLARIM_URL, { waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(2000);

	const clicked = await page.evaluate(({ buyerSteam, orderId }) => {
		const orderTag = `#${orderId}`;
		const rows = document.querySelectorAll('.user-panel-box, .item-detail.sale-detail');
		for (const row of rows) {
			const text = row.innerText || '';
			if (!text.includes(orderTag)) continue;
			const hasSteam = !!row.querySelector(`a[href="${buyerSteam}"], a[href="${buyerSteam}/"]`);
			if (!hasSteam) continue;
			const deliverBtn = Array.from(row.querySelectorAll('button'))
				.find(b => (b.innerText || '').trim() === 'Teslim Ettim');
			if (deliverBtn) {
				deliverBtn.click();
				return true;
			}
		}
		return false;
	}, { buyerSteam: order.buyerSteamUrl, orderId: order.orderId });

	if (!clicked) {
		throw new Error(`"Teslim Ettim" butonu bulunamadı (#${order.orderId} + ${order.buyerSteamUrl})`);
	}

	try {
		await page.waitForSelector('button:has-text("Evet, alıcıya teslim ettim")', { timeout: 5000 });
		await page.click('button:has-text("Evet, alıcıya teslim ettim")');
		console.log(`[orders] #${order.orderId} → onay modal'da "Evet" tıklandı`);
	} catch {
		console.log(`[orders] #${order.orderId} → onay modalı görünmedi (belki direkt submit oldu)`);
	}

	await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
	await page.waitForTimeout(2000);

	await page.goto(SATISLARIM_URL, { waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(2000);
	const stillPending = await page.evaluate(({ orderId }) => {
		const orderTag = `#${orderId}`;
		const rows = document.querySelectorAll('.user-panel-box, .item-detail.sale-detail');
		for (const row of rows) {
			const text = row.innerText || '';
			if (!text.includes(orderTag)) continue;
			const buttons = Array.from(row.querySelectorAll('button'));
			return buttons.some(b => (b.innerText || '').trim() === 'Teslim Ettim');
		}
		return false;
	}, { orderId: order.orderId });

	if (stillPending) {
		throw new Error(`#${order.orderId} hâlâ "Teslim Ettim" pending — onay aksiyonu çalışmadı`);
	}
	return true;
}

function buildDeliveryMessage(code) {
	return `Satin alim gerceklestirdigin icin tesekkur ederiz. Islemini hizlica baslatabilmen icin sana ozel tek kullanimlik kodun otomatik teslimat ile iletiliyor ve adim adim uygulama rehberimiz bu mesajda yer aliyor.

KOD: ${code}

Adim Adim Nasil Kullanilir?

1. Siteye Giris Yap: https://cscommends.com adresine git ve sag ustteki "Giris Yap" butonuna basarak sana verdigimiz kodu gir.
2. Bilgilerini Doldur: Acilan panelde "Ovgu Gonder" kismina Steam profil linkini (veya ID'ni) yapistir, ovgu turlerini sec ve miktarini belirle.
3. Sunucuya Baglan: Panelde sag tarafta yer alan "Sunucu Bilgileri" kismindaki "connect" ile baslayan komutu kopyala.
4. CS2'yi Baslat: Oyunun konsoluna kopyaladigin komutu yapistirarak sunucumuza katil.
5. Islemi Baslat: Sunucuya girdikten sonra sitedeki "Ovgu Gonder" butonuna bas ve onayla. Islemin basladigina dair bildirim aldiginda arkana yaslanip beklemen yeterli!

Herhangi bir sorun yasarsan destek ekibimizle iletisime gecmekten cekinme. Iyi oyunlar!`;
}

async function checkAlreadyMessaged(page, order) {
	if (!order.orderId) return false;
	await page.goto(SATISLARIM_URL, { waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(1500);

	const opened = await page.evaluate(({ buyerSteam, orderId }) => {
		const orderTag = `#${orderId}`;
		for (const btn of document.querySelectorAll('button')) {
			if ((btn.innerText || '').trim() !== 'Alıcı ile İletişime Geç') continue;
			let row = btn.parentElement;
			let depth = 0;
			while (row && depth < 12) {
				const text = row.innerText || '';
				const hasSteam = !!row.querySelector(`a[href="${buyerSteam}"], a[href="${buyerSteam}/"]`);
				if (hasSteam && text.includes(orderTag)) { btn.click(); return true; }
				row = row.parentElement;
				depth++;
			}
		}
		return false;
	}, { buyerSteam: order.buyerSteamUrl, orderId: order.orderId });
	if (!opened) return false;

	await page.waitForURL(url => url.toString().includes('/mesajlarim?active_tab='), { timeout: 15000 }).catch(() => {});
	await page.waitForTimeout(2500);

	const chatText = await page.evaluate(() => {
		const candidates = [
			'.chat-messages', '.conversation-messages', '.message-list',
			'[class*="ChatMessages"]', '[class*="conversationMessages"]',
			'[class*="messageList"]', '.chat-window', '.chat-content',
			'[class*="ChatWindow"]', '[class*="chatWindow"]',
			'main [class*="chat"]', 'main [class*="message"]'
		];
		for (const sel of candidates) {
			const el = document.querySelector(sel);
			if (el && (el.innerText || '').length > 20) return el.innerText;
		}
		const all = document.body.innerText || '';
		const lines = all.split('\n');
		return lines.slice(Math.floor(lines.length * 0.4)).join('\n');
	});

	const indicators = [
		/KOD\s*:\s*[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/i,
		/Satin alim gerceklestirdigin icin tesekkur ederiz/i,
		/cscommends\.com adresine git.*Kodu girip giri[şs] yap/i,
	];
	for (const re of indicators) {
		if (re.test(chatText)) return true;
	}
	return false;
}

async function processOrder(page, order, opts = {}) {
	const { generateCode } = require('./cscommends-client');
	const orderState = require('./order-state');
	const log = opts.log || console.log;

	if (orderState.isProcessed(order.orderId)) {
		log(`[orders] #${order.orderId} zaten işlenmiş — atlanıyor`);
		return { success: true, skipped: true };
	}

	let alreadyMessaged = false;
	try {
		alreadyMessaged = await checkAlreadyMessaged(page, order);
	} catch (err) {
		log(`[orders] #${order.orderId} ⚠ chat history check hatası: ${err.message} — yine de devam`);
	}
	if (alreadyMessaged) {
		log(`[orders] #${order.orderId} ⚠ chat'te önceki kod/teslim mesajı bulundu — sadece "Teslim Ettim" tıklanacak (mükerrer kod gitmesin)`);
		try {
			await markDelivered(page, order);
			orderState.recordOrder(order.orderId, {
				skipped: 'already_messaged',
				delivered: true,
				deliveredAt: new Date().toISOString(),
				buyer: order.buyer, product: order.product,
				productLabel: order.productLabel, productUrl: order.productUrl,
				buyerSteamUrl: order.buyerSteamUrl, orderDate: order.orderDate
			});
			return { success: true, skipped: 'already_messaged' };
		} catch (err) {
			orderState.recordOrder(order.orderId, { error: 'deliver_failed_after_skip', errorMessage: err.message });
			return { success: false, error: err.message };
		}
	}

	if (!order.product || !order.buyer) {
		log(`[orders] #${order.orderId} eksik veri — atlanıyor`);
		orderState.recordOrder(order.orderId, { error: 'missing_data', order });
		return { success: false, error: 'missing_data' };
	}

	let code;
	try {
		const balanceUnits = order.product.friendly;
		log(`[orders] #${order.orderId} → kod oluşturuluyor (${balanceUnits} bakiye = ${order.product.total} commend)...`);
		const result = await generateCode({
			balance: balanceUnits,
			productType: 'commend'
		});
		code = result.code;
		log(`[orders] #${order.orderId} → kod: ${code}`);
		orderState.recordOrder(order.orderId, {
			code, balance: balanceUnits, totalCommends: order.product.total,
			buyer: order.buyer, product: order.product,
			productLabel: order.productLabel, productUrl: order.productUrl,
			buyerSteamUrl: order.buyerSteamUrl, orderDate: order.orderDate
		});
	} catch (err) {
		log(`[orders] #${order.orderId} ✗ kod oluşturma hatası: ${err.message}`);
		orderState.recordOrder(order.orderId, { error: 'code_generate_failed', errorMessage: err.message });
		return { success: false, error: err.message };
	}

	const message = buildDeliveryMessage(code);
	try {
		log(`[orders] #${order.orderId} → alıcıya mesaj gönderiliyor...`);
		await sendMessageToBuyer(page, order, message);
		orderState.recordOrder(order.orderId, { messageSent: true, messageSentAt: new Date().toISOString() });
		log(`[orders] #${order.orderId} ✓ mesaj gönderildi`);
	} catch (err) {
		log(`[orders] #${order.orderId} ✗ mesaj hatası: ${err.message}`);
		orderState.recordOrder(order.orderId, { error: 'message_failed', errorMessage: err.message });
		return { success: false, error: err.message, code };
	}

	try {
		log(`[orders] #${order.orderId} → "Teslim Ettim" tıklanıyor...`);
		await markDelivered(page, order);
		orderState.recordOrder(order.orderId, { delivered: true, deliveredAt: new Date().toISOString(), error: null });
		log(`[orders] #${order.orderId} ✓ teslim edildi`);
	} catch (err) {
		log(`[orders] #${order.orderId} ✗ teslim hatası: ${err.message}`);
		orderState.recordOrder(order.orderId, { error: 'deliver_failed', errorMessage: err.message });
		return { success: false, error: err.message, code };
	}

	return { success: true, code };
}

async function pollOnce(page, opts = {}) {
	const orderState = require('./order-state');
	const log = opts.log || console.log;

	log('[orders] Pending siparişler taranıyor...');
	const orders = await listPendingOrders(page);
	log(`[orders] ${orders.length} bekleyen sipariş`);

	const results = [];
	for (const order of orders) {
		if (orderState.isProcessed(order.orderId)) continue;
		const r = await processOrder(page, order, { log });
		results.push({ orderId: order.orderId, ...r });
		await page.waitForTimeout(1500);
	}

	if (results.some(r => r.success && !r.skipped)) {
		try {
			const re = await reactivateOutOfStockListings(page, { log });
			if (re.reactivated) log(`[orders] ${re.reactivated} ilan yayına alındı`);
		} catch (err) {
			log(`[orders] reactivate hatası: ${err.message}`);
		}
	}

	orderState.updateLastPoll();
	log(`[orders] Poll tamam: ${results.filter(r => r.success).length}/${results.length} başarılı`);
	return results;
}

async function _scanOutOfStockCs2Cards(page) {
	return await page.evaluate(() => {
		const cardSelectors = [
			'.user-panel-box',
			'.item-detail.sale-detail',
			'.item-detail',
			'.sale-detail',
			'[class*="userPanelBox"]',
			'[class*="ListingCard"]'
		].join(', ');

		const cards = Array.from(document.querySelectorAll(cardSelectors));
		const cs2Cards = [];
		const skippedTitles = [];

		for (const card of cards) {
			const updateBtn = Array.from(card.querySelectorAll('a, button')).find(el => {
				const t = (el.innerText || el.textContent || '').trim();
				return t === 'İlanı Güncelle' || t === 'İlanı Yenile' || t === 'Yeniden Yayınla' || t === 'Stoğu Güncelle';
			});
			if (!updateBtn) continue;

			const cs2Link = card.querySelector('a[href*="cs2-ovgu-boost"]')?.href || null;
			if (!cs2Link) {
				const titleHint = (card.querySelector('h1,h2,h3,h4,.product-title,[class*="title"]')?.innerText || card.innerText || '').trim().substring(0, 60);
				skippedTitles.push(titleHint);
				continue;
			}

			let listingId = null;
			const idMatch = cs2Link.match(/(\d{4,})(?:[\/\?\#]|$)/);
			if (idMatch) listingId = idMatch[1];

			cs2Cards.push({
				productLink: cs2Link,
				listingId,
				titleHint: (card.querySelector('h3, h4, .product-title')?.innerText || '').trim().substring(0, 60)
			});
		}

		return { cs2Cards, skippedCount: skippedTitles.length, skippedTitles };
	});
}

async function reactivateOutOfStockListings(page, opts = {}) {
	const log = opts.log || console.log;
	await page.goto(`${ILANLARIM_URL}?durum=stoku-bitenler`, { waitUntil: 'domcontentloaded', timeout: 30000 });
	await page.waitForTimeout(2500);

	const initialScan = await _scanOutOfStockCs2Cards(page);
	const cs2Total = initialScan.cs2Cards.length;
	const skippedTotal = initialScan.skippedCount;

	if (cs2Total + skippedTotal === 0) {
		log('[reactivate] Stoku biten ilan yok');
		return { count: 0, reactivated: 0, skipped: 0 };
	}

	log(`[reactivate] ${cs2Total + skippedTotal} stoku biten ilan tespit — ${cs2Total} cs2-ovgu-boost (işlenecek), ${skippedTotal} farklı kategori (atlandı)`);

	if (skippedTotal > 0) {
		initialScan.skippedTitles.slice(0, 5).forEach((t, i) => {
			log(`[reactivate] ⊘ atlandı: "${t || '(başlıksız)'}"`);
		});
		if (skippedTotal > 5) log(`[reactivate] ⊘ +${skippedTotal - 5} ilan daha atlandı`);
	}

	if (cs2Total === 0) {
		log('[reactivate] İşlenecek cs2-ovgu-boost ilanı yok');
		return { count: skippedTotal, reactivated: 0, skipped: skippedTotal };
	}

	const first = initialScan.cs2Cards[0];
	log(`[reactivate] sample: listingId=${first.listingId || '?'} url=${first.productLink}`);

	let reactivated = 0;
	let failed = 0;
	const processedListings = new Set();

	const MAX_ITERATIONS = cs2Total + 2;
	for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
		await page.goto(`${ILANLARIM_URL}?durum=stoku-bitenler`, { waitUntil: 'domcontentloaded', timeout: 30000 });
		await page.waitForTimeout(2000);

		const scan = await _scanOutOfStockCs2Cards(page);
		const target = scan.cs2Cards.find(c => !processedListings.has(c.listingId || c.productLink));
		if (!target) {
			break;
		}

		const tag = target.listingId ? `#${target.listingId}` : `(${target.productLink.slice(-40)})`;
		try {
			const clickResult = await page.evaluate((targetUrl) => {
				const cardSelectors = [
					'.user-panel-box',
					'.item-detail.sale-detail',
					'.item-detail',
					'.sale-detail',
					'[class*="userPanelBox"]',
					'[class*="ListingCard"]'
				].join(', ');
				const cards = Array.from(document.querySelectorAll(cardSelectors));
				for (const card of cards) {
					const cs2Link = card.querySelector('a[href*="cs2-ovgu-boost"]')?.href || null;
					if (cs2Link !== targetUrl) continue;
					const updateBtn = Array.from(card.querySelectorAll('a, button')).find(el => {
						const t = (el.innerText || el.textContent || '').trim();
						return t === 'İlanı Güncelle' || t === 'İlanı Yenile' || t === 'Yeniden Yayınla' || t === 'Stoğu Güncelle';
					});
					if (!updateBtn) continue;
					updateBtn.scrollIntoView({ block: 'center' });
					updateBtn.click();
					return { clicked: true, btnTag: updateBtn.tagName };
				}
				return { clicked: false };
			}, target.productLink);

			if (!clickResult.clicked) {
				log(`[reactivate] ✗ ${tag}: "İlanı Güncelle" butonu tıklanamadı`);
				processedListings.add(target.listingId || target.productLink);
				failed++;
				continue;
			}

			const startUrl = page.url();
			await Promise.race([
				page.waitForURL((url) => url.toString() !== startUrl, { timeout: 12000 }),
				page.waitForSelector('input[name="stok"], input[name="stock"], input[name="adet"], input[name="quantity"]', { timeout: 12000 }),
				page.waitForLoadState('networkidle', { timeout: 12000 })
			]).catch(() => {});
			await page.waitForTimeout(1800);

			const editorUrl = page.url();

			const stokSelectors = [
				'input[name="stok"]',
				'input[name="stock"]',
				'input[name="adet"]',
				'input[name="quantity"]',
				'input[name="kalan_stok"]',
				'input[name="urun_stok"]',
				'input[id*="stok" i]',
				'input[id*="stock" i]',
				'input[placeholder*="stok" i]',
				'input[placeholder*="adet" i]',
				'input[type="number"]'
			];
			let stokInput = null;
			let stokSelectorUsed = null;
			for (const sel of stokSelectors) {
				stokInput = await page.$(sel);
				if (stokInput) { stokSelectorUsed = sel; break; }
			}

			if (!stokInput) {
				log(`[reactivate] ✗ ${tag}: editör sayfasında stok input yok (${editorUrl})`);
				processedListings.add(target.listingId || target.productLink);
				failed++;
				continue;
			}

			const before = await stokInput.evaluate(el => el.value);
			await stokInput.fill('1');
			const after = await stokInput.evaluate(el => el.value);

			const submitSelectors = [
				'button[type="submit"]:has-text("Kaydet")',
				'button[type="submit"]:has-text("Güncelle")',
				'button[type="submit"]:has-text("Yayınla")',
				'button:has-text("Kaydet")',
				'button:has-text("Güncelle")',
				'input[type="submit"]'
			];
			let submitBtn = null;
			let submitSelectorUsed = null;
			for (const sel of submitSelectors) {
				submitBtn = await page.$(sel);
				if (submitBtn) { submitSelectorUsed = sel; break; }
			}

			if (!submitBtn) {
				log(`[reactivate] ✗ ${tag}: submit butonu yok (${editorUrl})`);
				processedListings.add(target.listingId || target.productLink);
				failed++;
				continue;
			}

			await submitBtn.click();
			await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
			await page.waitForTimeout(1500);

			reactivated++;
			processedListings.add(target.listingId || target.productLink);
			log(`[reactivate] ✓ ${tag} stok ${before}→${after} (input=${stokSelectorUsed}, submit=${submitSelectorUsed})`);
		} catch (err) {
			log(`[reactivate] ✗ ${tag}: ${err.message}`);
			processedListings.add(target.listingId || target.productLink);
			failed++;
		}
	}

	log(`[reactivate] Tamamlandı: ${reactivated} yayına alındı, ${failed} başarısız (cs2 toplam: ${cs2Total}, atlandı: ${skippedTotal})`);
	return { count: cs2Total + skippedTotal, reactivated, failed, skipped: skippedTotal, processable: cs2Total };
}

module.exports = {
	listPendingOrders,
	sendMessageToBuyer,
	markDelivered,
	processOrder,
	pollOnce,
	reactivateOutOfStockListings,
	buildDeliveryMessage,
	parseProduct,
	parseSteamProfile,
	SATISLARIM_URL,
	ILANLARIM_URL
};
