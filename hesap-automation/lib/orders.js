const cheerio = require('cheerio');

const SATTIGIM_PATH = '/p/sattigim-ilanlar';
const PASIF_PATH = '/p/pasifilanlarim';
const ILANLARIM_PATH = '/p/ilanlarim';

const CS2_OVGU_PATTERN = /cs2-\d+-ovgu/i;

const OUR_LISTING_IDS = new Set([
	897737,
	897747,
	897756,
	897759,
	897749
]);

function parseListingUrl(url) {
	if (!url) return null;
	const m = url.match(/\/ilan\/(\d+)-cs2-(\d+)-ovgu/i);
	if (!m) return null;
	return { id: parseInt(m[1], 10), commendCount: parseInt(m[2], 10) };
}

function isOurListing(url) {
	const parsed = parseListingUrl(url);
	if (!parsed) return false;
	return OUR_LISTING_IDS.has(parsed.id);
}

async function listPendingOrders(client) {
	const r = await client.get(SATTIGIM_PATH);
	if (r.status !== 200) {
		throw new Error(`/p/sattigim-ilanlar HTTP ${r.status}`);
	}
	const $ = cheerio.load(r.data);

	const candidates = [];
	$('a[href*="/ilan/"]').each((i, el) => {
		const href = $(el).attr('href') || '';
		if (!isOurListing(href)) return;
		const parsed = parseListingUrl(href);
		const $card = $(el).closest('[class*="card"], [class*="item"], li, tr, .order, [class*="order"]');
		candidates.push({
			productLink: href,
			listingId: parsed?.id,
			commendCount: parsed?.commendCount,
			cardClass: ($card.attr('class') || '').substring(0, 80),
			cardTextPreview: ($card.text() || '').trim().substring(0, 200).replace(/\s+/g, ' ')
		});
	});

	const title = $('title').text();

	return {
		orders: [],
		_dryRunCandidates: candidates,
		totalCardsFound: candidates.length,
		page: title,
		responseSize: r.data.length
	};
}

async function pollOnce(client, opts = {}) {
	const log = opts.log || console.log;

	const result = await listPendingOrders(client);

	if (result.totalCardsFound > 0) {
		if (typeof global.__hesapOrderBaseline === 'undefined') {
			global.__hesapOrderBaseline = result.totalCardsFound;
			log(`[hesap-orders] poll baseline: ${result.totalCardsFound} sipariş kartı (tarihçe — bu sayı arttıkça yeni sipariş gelmiş olur)`);
		} else if (result.totalCardsFound > global.__hesapOrderBaseline) {
			const delta = result.totalCardsFound - global.__hesapOrderBaseline;
			log(`[hesap-orders] 🔴 YENİ SİPARİŞ ALARMI! ${delta} yeni sipariş tespit (${global.__hesapOrderBaseline} → ${result.totalCardsFound})`);
			global.__hesapOrderBaseline = result.totalCardsFound;
			try {
				const config = require('../../config.json');
				const url = config.webhookUrl;
				if (url && url.startsWith('http')) {
					const newOrders = (result._dryRunCandidates || []).slice(-delta);
					const message = `🔴 **HESAP.COM.TR — ${delta} YENİ SİPARİŞ!**\nBekleyen: yeni listing ${newOrders.map(c => `#${c.listingId} (${c.commendCount} commend)`).join(', ')}\nDOM/endpoint keşfi tamamlanmadığı için otomatik teslim YOK — manuel müdahale gerek.\nAdmin paneli > 🛒 hesap.com.tr`;
					(global.fetch || require('node-fetch'))(url, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ content: message })
					}).catch(() => {});
				}
			} catch {}
		}
	}

	return [];
}

async function reactivatePassiveListings(client, opts = {}) {
	const log = opts.log || console.log;
	const r = await client.get(PASIF_PATH);
	if (r.status !== 200) {
		throw new Error(`/p/pasifilanlarim HTTP ${r.status}`);
	}
	const $ = cheerio.load(r.data);
	const cs2Cards = $('a[href*="cs2-ovgu"]').length;
	log(`[hesap-reactivate] [DRY-RUN] sayfa OK | cs2-ovgu link: ${cs2Cards} | (henüz reactivate endpoint bilinmiyor)`);
	return { count: cs2Cards, reactivated: 0, note: 'dry-run — endpoint keşfi bekleniyor' };
}

module.exports = {
	listPendingOrders,
	pollOnce,
	reactivatePassiveListings,
	SATTIGIM_PATH,
	PASIF_PATH,
	ILANLARIM_PATH,
	CS2_OVGU_PATTERN,
	OUR_LISTING_IDS,
	parseListingUrl,
	isOurListing
};
