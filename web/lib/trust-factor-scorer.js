const APP_CS2 = 730;

const WEIGHTS = {
	accountAge:    15,
	cs2Hours:      25,
	gameLibrary:    8,
	steamLevel:    10,
	friendCount:    5,
	profilePublic:  7,
	lastOnline:     5,
	commendCount:  15,
	noBans:        10
};

function band(value, breakpoints) {
	for (const b of breakpoints) {
		if (value >= b.min) return b.score;
	}
	return 0;
}

function ageInYears(timestamp) {
	if (!timestamp) return 0;
	return (Date.now() / 1000 - timestamp) / (365.25 * 86400);
}

function daysSince(timestamp) {
	if (!timestamp) return Infinity;
	return (Date.now() / 1000 - timestamp) / 86400;
}

function scoreAccountAge(timecreated) {
	if (!timecreated) return { points: 0, max: WEIGHTS.accountAge, label: 'bilinmiyor', detail: 'Profil gizli olabilir' };
	const years = ageInYears(timecreated);
	const ratio = band(years, [
		{ min: 10, score: 1.0 },
		{ min: 5,  score: 0.85 },
		{ min: 3,  score: 0.65 },
		{ min: 1,  score: 0.4 },
		{ min: 0,  score: 0.15 }
	]);
	return {
		points: Math.round(ratio * WEIGHTS.accountAge * 10) / 10,
		max: WEIGHTS.accountAge,
		label: years.toFixed(1) + ' yıl',
		detail: years >= 5 ? 'Köklü hesap, güçlü sinyal' : (years >= 1 ? 'Makul yaş' : 'Yeni hesap, düşük güven sinyali')
	};
}

function scoreCs2Hours(hours) {
	if (hours == null) return { points: 0, max: WEIGHTS.cs2Hours, label: 'bilinmiyor', detail: 'Oyun süreleri gizli' };
	const ratio = band(hours, [
		{ min: 2000, score: 1.0 },
		{ min: 1000, score: 0.9 },
		{ min: 500,  score: 0.75 },
		{ min: 250,  score: 0.6 },
		{ min: 100,  score: 0.35 },
		{ min: 25,   score: 0.15 },
		{ min: 0,    score: 0 }
	]);
	let detail;
	if (hours >= 1000) detail = 'Tecrübeli CS2 oyuncusu';
	else if (hours >= 250) detail = 'FACEIT 250 saat şartını karşılıyor';
	else if (hours >= 100) detail = 'Az saat — Trust için yetersiz olabilir';
	else detail = 'Çok az saat — FACEIT eligible değil';
	return {
		points: Math.round(ratio * WEIGHTS.cs2Hours * 10) / 10,
		max: WEIGHTS.cs2Hours,
		label: Math.round(hours) + ' saat',
		detail
	};
}

function scoreGameLibrary(count) {
	if (count == null) return { points: 0, max: WEIGHTS.gameLibrary, label: 'bilinmiyor', detail: 'Oyun listesi gizli' };
	const ratio = band(count, [
		{ min: 100, score: 1.0 },
		{ min: 30,  score: 0.75 },
		{ min: 10,  score: 0.45 },
		{ min: 3,   score: 0.2 },
		{ min: 0,   score: 0 }
	]);
	return {
		points: Math.round(ratio * WEIGHTS.gameLibrary * 10) / 10,
		max: WEIGHTS.gameLibrary,
		label: count + ' oyun',
		detail: count >= 30 ? 'Geniş kütüphane' : (count >= 10 ? 'Orta seviye' : 'Az oyun, yatırım sinyali zayıf')
	};
}

function scoreSteamLevel(level) {
	if (level == null) return { points: 0, max: WEIGHTS.steamLevel, label: 'bilinmiyor', detail: '' };
	const ratio = band(level, [
		{ min: 50, score: 1.0 },
		{ min: 30, score: 0.85 },
		{ min: 20, score: 0.7 },
		{ min: 10, score: 0.5 },
		{ min: 5,  score: 0.25 },
		{ min: 0,  score: 0.05 }
	]);
	return {
		points: Math.round(ratio * WEIGHTS.steamLevel * 10) / 10,
		max: WEIGHTS.steamLevel,
		label: 'Lvl ' + level,
		detail: level >= 20 ? 'Aktif community kullanıcısı' : (level >= 5 ? 'Orta' : 'Çok düşük seviye')
	};
}

function scoreFriendCount(count) {
	if (count == null) return { points: 0, max: WEIGHTS.friendCount, label: 'bilinmiyor', detail: 'Arkadaş listesi gizli' };
	const ratio = band(count, [
		{ min: 100, score: 1.0 },
		{ min: 30,  score: 0.75 },
		{ min: 10,  score: 0.5 },
		{ min: 3,   score: 0.2 },
		{ min: 0,   score: 0.05 }
	]);
	return {
		points: Math.round(ratio * WEIGHTS.friendCount * 10) / 10,
		max: WEIGHTS.friendCount,
		label: count + ' arkadaş',
		detail: count >= 30 ? 'Sosyal aktif' : (count >= 5 ? 'Orta' : 'Çok az arkadaş — bot sinyali olabilir')
	};
}

function scoreProfilePublic(visibility) {
	if (visibility === 3) return { points: WEIGHTS.profilePublic, max: WEIGHTS.profilePublic, label: 'Public', detail: 'Şeffaf profil' };
	if (visibility === 2) return { points: WEIGHTS.profilePublic * 0.4, max: WEIGHTS.profilePublic, label: 'Friends-only', detail: 'Yarı gizli' };
	return { points: 0, max: WEIGHTS.profilePublic, label: 'Private', detail: 'Profil tamamen gizli — Trust olumsuz' };
}

function scoreLastOnline(lastlogoff, personastate) {
	if (personastate && personastate !== 0) {
		return { points: WEIGHTS.lastOnline, max: WEIGHTS.lastOnline, label: 'Şu an online', detail: 'Aktif kullanıcı' };
	}
	if (!lastlogoff) return { points: 0, max: WEIGHTS.lastOnline, label: 'bilinmiyor', detail: '' };
	const days = daysSince(lastlogoff);
	const ratio = band(days, [
		{ min: 0,   score: 1.0 },
		{ min: -Infinity, score: 0 }
	]);
	let points;
	let detail;
	if (days <= 7) { points = WEIGHTS.lastOnline; detail = 'Aktif (son 7 gün)'; }
	else if (days <= 30) { points = WEIGHTS.lastOnline * 0.7; detail = 'Yakın zamanda aktif'; }
	else if (days <= 90) { points = WEIGHTS.lastOnline * 0.4; detail = 'Az aktif'; }
	else { points = 0; detail = 'Uzun süredir online değil — Trust düşürür'; }
	return {
		points: Math.round(points * 10) / 10,
		max: WEIGHTS.lastOnline,
		label: Math.round(days) + ' gün önce',
		detail
	};
}

function scoreCommendCount(commendData) {
	if (!commendData) return { points: 0, max: WEIGHTS.commendCount, label: 'sorgulanmadı', detail: 'Detaylı analiz için derin tarama gerekir', skipped: true };
	const total = commendData.total || (commendData.friendly + commendData.teaching + commendData.leader);
	const ratio = band(total, [
		{ min: 500, score: 1.0 },
		{ min: 200, score: 0.85 },
		{ min: 100, score: 0.6 },
		{ min: 30,  score: 0.3 },
		{ min: 0,   score: 0.05 }
	]);
	let detail;
	if (total >= 200) detail = 'Yüksek commend — güçlü pozitif sinyal';
	else if (total >= 100) detail = 'İyi seviye';
	else if (total >= 30) detail = 'Düşük — boost önerilir';
	else detail = 'Çok az commend — Trust için kritik eksik';
	return {
		points: Math.round(ratio * WEIGHTS.commendCount * 10) / 10,
		max: WEIGHTS.commendCount,
		label: total + ' commend',
		detail,
		breakdown: { friendly: commendData.friendly, teaching: commendData.teaching, leader: commendData.leader }
	};
}

function scoreBans(bans) {
	if (!bans) return { points: 0, max: WEIGHTS.noBans, label: 'bilinmiyor', detail: '' };
	const penalties = [];
	let pointsLost = 0;
	if (bans.VACBanned || bans.NumberOfVACBans > 0) {
		penalties.push(`${bans.NumberOfVACBans || 1} VAC ban`);
		pointsLost += 100;
	}
	if (bans.NumberOfGameBans > 0) {
		penalties.push(`${bans.NumberOfGameBans} game ban`);
		pointsLost += 50;
	}
	if (bans.CommunityBanned) {
		penalties.push('community ban');
		pointsLost += 30;
	}
	if (bans.EconomyBan && bans.EconomyBan !== 'none') {
		penalties.push(`economy ban (${bans.EconomyBan})`);
		pointsLost += 15;
	}
	if (penalties.length === 0) {
		return { points: WEIGHTS.noBans, max: WEIGHTS.noBans, label: 'Temiz', detail: 'Hiç ban yok ✓' };
	}
	return { points: 0, max: WEIGHTS.noBans, label: penalties.join(', '), detail: '⛔ Bu hesap ciddi şekilde etkilendi', penalty: pointsLost };
}

function scoreToTier(score) {
	if (score >= 80) return { tier: 'green',    color: '#22c55e', label: 'Yeşil (Mükemmel)',     description: 'Trust Factor güçlü. Premier ve MM\'de kaliteli oyuncularla eşleşirsin.' };
	if (score >= 60) return { tier: 'yellow',   color: '#eab308', label: 'Sarı (İyi)',           description: 'Ortalama üstü. Geliştirme için commend ve saat artırılabilir.' };
	if (score >= 40) return { tier: 'orange',   color: '#f59e0b', label: 'Turuncu (Orta)',       description: 'Riskli bölge. Commend boost ve aktivite artışı önerilir.' };
	if (score >= 20) return { tier: 'red',      color: '#ef4444', label: 'Kırmızı (Düşük)',      description: 'Cheater havuzunda eşleşme riski yüksek. Acil aksiyon gerekli.' };
	return                  { tier: 'critical', color: '#7f1d1d', label: 'Kritik (Çok Düşük)',   description: 'Banlanmış veya yepyeni hesap. Yeni hesap önerilir.' };
}

function buildRecommendations(breakdown, score) {
	const recs = [];

	if (breakdown.cs2Hours.points < WEIGHTS.cs2Hours * 0.6) {
		const hours = parseInt(String(breakdown.cs2Hours.label).match(/\d+/)?.[0] || '0', 10);
		const need = Math.max(250, hours + 100);
		recs.push({
			priority: 1,
			icon: '⏱️',
			title: 'CS2 Saat Boost',
			reason: `Mevcut ${hours} saat; FACEIT için min 250, Trust için 500+ önerilir.`,
			action: `${Math.max(250 - hours, 100)} saat boost al`,
			ctaLabel: 'Hours Boost İncele',
			ctaUrl: '/hours-boost'
		});
	}

	if (!breakdown.commendCount.skipped && breakdown.commendCount.points < WEIGHTS.commendCount * 0.6) {
		const total = parseInt(String(breakdown.commendCount.label).match(/\d+/)?.[0] || '0', 10);
		const need = total < 100 ? 600 : 300;
		recs.push({
			priority: 1,
			icon: '👍',
			title: `${need} CS2 Commend Paketi`,
			reason: `${total} commend mevcut; Trust için 200+ önerilir.`,
			action: `${need} commend paketi`,
			ctaLabel: 'Sipariş Ver',
			ctaUrl: '/'
		});
	}

	if (breakdown.commendCount.skipped) {
		recs.push({
			priority: 2,
			icon: '👍',
			title: 'CS2 Commend Boost',
			reason: 'Commend sayını ölçemedik (derin analiz gerekiyor) ama düşükse Trust\'i ciddi etkiler.',
			action: '20 ücretsiz commend ile başla, sonuca göre paket al',
			ctaLabel: '20 Ücretsiz Al',
			ctaUrl: '/free-commend'
		});
	}

	if (breakdown.profilePublic.label === 'Private') {
		recs.push({
			priority: 2,
			icon: '👁️',
			title: 'Profilini herkese aç',
			reason: 'Gizli profiller Trust\'ı düşürür (Steam: Profil → Gizlilik Ayarları → Public).',
			action: 'Steam ayarlarını aç',
			ctaLabel: 'Steam Profili',
			ctaUrl: 'https://steamcommunity.com/my/edit/settings',
			external: true
		});
	}

	if (breakdown.friendCount.points < WEIGHTS.friendCount * 0.5) {
		recs.push({
			priority: 3,
			icon: '👥',
			title: 'Sosyal aktivite artır',
			reason: 'Az arkadaş + az grup üyeliği bot sinyali oluşturuyor.',
			action: 'Steam grubuna üye ol veya bot grubuna üye ekle',
			ctaLabel: 'Group Boost',
			ctaUrl: '/group-boost'
		});
	}

	if (breakdown.bans.penalty) {
		recs.push({
			priority: 0,
			icon: '⚠️',
			title: 'Banlanmış hesap',
			reason: 'VAC/game ban\'lı hesap Trust\'ı toparlayamaz. Temiz hesap önerilir.',
			action: 'Yeni hesap oluştur + Prime al + buradan boost yap',
			ctaLabel: 'Detay Blog',
			ctaUrl: '/blog/cs2-overwatch-banned'
		});
	}

	if (score >= 80 && recs.length === 0) {
		recs.push({
			priority: 5,
			icon: '🎉',
			title: 'Profilin harika!',
			reason: 'Trust Factor\'ün güçlü görünüyor. Performansını korumak için ara sıra commend ekleyebilirsin.',
			action: 'Sürekli %5-10 ek commend için aboneliği değerlendir',
			ctaLabel: 'Bayi Ol (toplu için)',
			ctaUrl: '/bayilik'
		});
	}

	return recs.sort((a, b) => a.priority - b.priority);
}

function computeScore(profile, options = {}) {
	const breakdown = {
		accountAge:   scoreAccountAge(profile.timecreated),
		cs2Hours:     scoreCs2Hours(profile.cs2Hours),
		gameLibrary:  scoreGameLibrary(profile.gameCount),
		steamLevel:   scoreSteamLevel(profile.steamLevel),
		friendCount:  scoreFriendCount(profile.friendCount),
		profilePublic: scoreProfilePublic(profile.communityvisibilitystate),
		lastOnline:   scoreLastOnline(profile.lastlogoff, profile.personastate),
		commendCount: scoreCommendCount(profile.commendData),
		bans:         scoreBans(profile.bans)
	};

	let totalScore = 0;
	for (const key of Object.keys(breakdown)) {
		if (key === 'bans') continue;
		totalScore += breakdown[key].points;
	}

	totalScore += breakdown.bans.points;
	if (breakdown.bans.penalty) {
		totalScore -= breakdown.bans.penalty;
	}

	totalScore = Math.max(0, Math.min(100, Math.round(totalScore * 10) / 10));

	const tier = scoreToTier(totalScore);
	const recommendations = buildRecommendations(breakdown, totalScore);

	return {
		score: totalScore,
		maxScore: 100,
		tier,
		breakdown,
		recommendations,
		analyzedAt: new Date().toISOString(),
		deepAnalysis: !breakdown.commendCount.skipped
	};
}

module.exports = {
	computeScore,
	WEIGHTS
};
