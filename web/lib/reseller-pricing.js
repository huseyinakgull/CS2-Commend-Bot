const CURRENCY = 'TRY';

const COST_PER_BOT = 0.58;
const COST_PER_COMMEND = COST_PER_BOT;
const COST_PER_GROUP_MEMBER = COST_PER_BOT;
const COST_PER_HOUR = 0.002;

const TIERS = [
	{
		id: 'bronze',
		name: 'Bronze',
		emoji: '🥉',
		tagline: 'Yeni başlayan bayiler',
		monthlyPrice: 4500,
		setupFee: 0,
		quota: { commend: 5000, hours: 1000, group: 200 },
		marginPct: 50,
		features: [
			'Aylık 5.000 commend kotası',
			'Aylık 1.000 saat boost kotası',
			'Aylık 200 Steam grup üyesi',
			'Bayi paneli (gerçek zamanlı)',
			'Kod üretici (limit dahilinde)',
			'Discord standart destek',
			'~%50 brüt kar marjı'
		]
	},
	{
		id: 'silver',
		name: 'Silver',
		emoji: '🥈',
		tagline: 'Aktif reseller / küçük platform',
		monthlyPrice: 14900,
		setupFee: 0,
		recommended: false,
		quota: { commend: 15000, hours: 3000, group: 600 },
		marginPct: 65,
		features: [
			'Aylık 15.000 commend kotası',
			'Aylık 3.000 saat boost kotası',
			'Aylık 600 Steam grup üyesi',
			'Bayi paneli + analitik',
			'Discord öncelikli destek',
			'Gelişmiş kod üretici (toplu)',
			'~%65 brüt kar marjı'
		]
	},
	{
		id: 'gold',
		name: 'Gold',
		emoji: '🥇',
		tagline: 'Profesyonel platform / itemsatış benzeri',
		monthlyPrice: 54000,
		setupFee: 0,
		recommended: true,
		quota: { commend: 50000, hours: 10000, group: 2000 },
		marginPct: 80,
		features: [
			'Aylık 50.000 commend kotası',
			'Aylık 10.000 saat boost kotası',
			'Aylık 2.000 Steam grup üyesi',
			'Bayi paneli + canlı analitik',
			'Discord VIP destek (özel kanal)',
			'Sınırsız kod üretici',
			'API erişimi (yakında)',
			'~%80 brüt kar marjı'
		]
	},
	{
		id: 'platinum',
		name: 'Platinum',
		emoji: '💎',
		tagline: 'Kurumsal / white-label',
		monthlyPrice: 240000,
		setupFee: 0,
		recommended: false,
		quota: { commend: 200000, hours: 50000, group: 10000 },
		marginPct: 100,
		features: [
			'Aylık 200.000 commend kotası',
			'Aylık 50.000 saat boost kotası',
			'Aylık 10.000 Steam grup üyesi',
			'Özel hesap yöneticisi',
			'Discord VIP destek (7/24)',
			'White-label opsiyonu',
			'API erişimi',
			'Toplu hesap satışı uygunluğu',
			'~%100 brüt kar marjı'
		]
	}
];

const RATES = {
	commend: [
		{ from: 1,      to: 9999,    pricePerUnit: 0.90 },
		{ from: 10000,  to: 49999,   pricePerUnit: 0.80 },
		{ from: 50000,  to: 199999,  pricePerUnit: 0.70 },
		{ from: 200000, to: Infinity, pricePerUnit: 0.65 }
	],
	hours: [
		{ from: 1,     to: 4999,    pricePerUnit: 0.05 },
		{ from: 5000,  to: 19999,   pricePerUnit: 0.04 },
		{ from: 20000, to: Infinity, pricePerUnit: 0.03 }
	],
	group: [
		{ from: 1,    to: 999,     pricePerUnit: 0.95 },
		{ from: 1000, to: 4999,    pricePerUnit: 0.85 },
		{ from: 5000, to: Infinity, pricePerUnit: 0.75 }
	]
};

const MIN_TOTAL_TRY = 1000;
const MIN_PER_PRODUCT = {
	commend: 1000,
	hours:   200,
	group:   50
};

function findRate(product, quantity) {
	const bands = RATES[product];
	if (!bands) return null;
	for (const b of bands) {
		if (quantity >= b.from && quantity <= b.to) return b.pricePerUnit;
	}
	return bands[bands.length - 1].pricePerUnit;
}

function calculateCustom({ commend = 0, hours = 0, group = 0 } = {}) {
	const c = Math.max(0, Math.floor(Number(commend) || 0));
	const h = Math.max(0, Math.floor(Number(hours)   || 0));
	const g = Math.max(0, Math.floor(Number(group)   || 0));

	if (c === 0 && h === 0 && g === 0) {
		return { ok: false, error: 'En az bir ürün için kota belirtin.' };
	}

	for (const [prod, qty] of Object.entries({ commend: c, hours: h, group: g })) {
		if (qty > 0 && qty < MIN_PER_PRODUCT[prod]) {
			return {
				ok: false,
				error: `Minimum ${prod} kotası: ${MIN_PER_PRODUCT[prod]} (${qty} istendi).`
			};
		}
	}

	const rateC = findRate('commend', c);
	const rateH = findRate('hours', h);
	const rateG = findRate('group', g);

	const breakdown = {
		commend: { quantity: c, rate: rateC, subtotal: Number((c * rateC).toFixed(2)) },
		hours:   { quantity: h, rate: rateH, subtotal: Number((h * rateH).toFixed(2)) },
		group:   { quantity: g, rate: rateG, subtotal: Number((g * rateG).toFixed(2)) }
	};
	const total = Number((breakdown.commend.subtotal + breakdown.hours.subtotal + breakdown.group.subtotal).toFixed(2));

	if (total < MIN_TOTAL_TRY) {
		return { ok: false, error: `Minimum tutar: ${MIN_TOTAL_TRY} ₺ (hesaplanan: ${total} ₺).` };
	}

	return { ok: true, total, currency: CURRENCY, breakdown };
}

function buildDiscordMessage({ tierId, customQuota, total }) {
	if (tierId) {
		const tier = TIERS.find(t => t.id === tierId);
		if (tier) {
			return `Merhaba! ${tier.emoji} ${tier.name} bayilik paketi (aylık ${tier.monthlyPrice} ₺) almak istiyorum.`;
		}
	}
	if (customQuota && total) {
		const parts = [];
		if (customQuota.commend > 0) parts.push(`${customQuota.commend} commend`);
		if (customQuota.hours > 0)   parts.push(`${customQuota.hours} saat`);
		if (customQuota.group > 0)   parts.push(`${customQuota.group} grup üyesi`);
		return `Merhaba! Özel bayilik paketi almak istiyorum: aylık ${parts.join(' + ')} (~${total} ₺).`;
	}
	return 'Merhaba! Bayilik almak hakkında bilgi alabilir miyim?';
}

module.exports = {
	CURRENCY,
	TIERS,
	RATES,
	MIN_TOTAL_TRY,
	MIN_PER_PRODUCT,
	findRate,
	calculateCustom,
	buildDiscordMessage
};
