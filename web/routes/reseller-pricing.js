const express = require('express');
const { TIERS, RATES, MIN_TOTAL_TRY, MIN_PER_PRODUCT, CURRENCY, calculateCustom, buildDiscordMessage } = require('../lib/reseller-pricing');

const router = express.Router();

router.get('/tiers', (req, res) => {
	res.json({
		currency: CURRENCY,
		tiers: TIERS,
		rates: RATES,
		minimums: { totalTRY: MIN_TOTAL_TRY, perProduct: MIN_PER_PRODUCT }
	});
});

router.get('/calculate', (req, res) => {
	const r = calculateCustom({
		commend: req.query.commend,
		hours:   req.query.hours,
		group:   req.query.group
	});
	if (r.ok) {
		r.discordMessage = buildDiscordMessage({
			customQuota: { commend: r.breakdown.commend.quantity, hours: r.breakdown.hours.quantity, group: r.breakdown.group.quantity },
			total: r.total
		});
	}
	res.json(r);
});

router.post('/calculate', (req, res) => {
	const r = calculateCustom(req.body || {});
	if (r.ok) {
		r.discordMessage = buildDiscordMessage({
			customQuota: { commend: r.breakdown.commend.quantity, hours: r.breakdown.hours.quantity, group: r.breakdown.group.quantity },
			total: r.total
		});
	}
	res.json(r);
});

router.get('/discord-message', (req, res) => {
	res.json({ message: buildDiscordMessage({ tierId: req.query.tier }) });
});

module.exports = router;
