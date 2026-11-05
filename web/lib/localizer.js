const fs = require('fs');
const path = require('path');

const OG_LOCALES = {
	tr: 'tr_TR',
	en: 'en_US',
	de: 'de_DE',
	ru: 'ru_RU',
	pl: 'pl_PL',
	pt: 'pt_BR',
	es: 'es_ES',
	fr: 'fr_FR'
};

const LANGS = Object.keys(OG_LOCALES);

const langStrings = {};

function loadAllLangs(publicDir) {
	for (const l of LANGS) {
		const p = path.join(publicDir, 'lang', l + '.json');
		try { langStrings[l] = JSON.parse(fs.readFileSync(p, 'utf8')); }
		catch (e) {
			langStrings[l] = null;
		}
	}
}

function reloadLang(lang, publicDir) {
	const p = path.join(publicDir, 'lang', lang + '.json');
	try { langStrings[lang] = JSON.parse(fs.readFileSync(p, 'utf8')); }
	catch { langStrings[lang] = null; }
}

function getStrings(lang) {
	return langStrings[lang] || langStrings.en || langStrings.tr || {};
}

function tr(key, lang) {
	const primary = getStrings(lang);
	if (primary && primary[key] !== undefined) return primary[key];
	const en = langStrings.en;
	if (en && en[key] !== undefined) return en[key];
	const turkish = langStrings.tr;
	if (turkish && turkish[key] !== undefined) return turkish[key];
	return null;
}

const cache = new Map();
const CACHE_MAX = 200;

function cacheGet(key) { return cache.get(key); }
function cacheSet(key, val) {
	if (cache.size >= CACHE_MAX) {
		const firstKey = cache.keys().next().value;
		cache.delete(firstKey);
	}
	cache.set(key, val);
}

function escapeAttr(s) {
	if (s == null) return '';
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function stripTags(s) {
	if (s == null) return '';
	return String(s).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
}

function localizeHtml(html, lang, urlPrefix) {
	const ogLocale = OG_LOCALES[lang] || OG_LOCALES.en;

	const lookup = (key) => tr(key, lang);

	html = html.replace(/(<html\b[^>]*\blang=)["'][^"']*["']/i, `$1"${lang}"`);

	html = html.replace(
		/<(\w+)((?:[^>"']|"[^"]*"|'[^']*')*\sdata-i18n=)(["'])([^"']+)\3((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\1>/g,
		(m, tag, prefix, q, key, suffix, content) => {
			const val = lookup(key);
			if (val === null) return m;
			return `<${tag}${prefix}${q}${key}${q}${suffix}>${val}</${tag}>`;
		}
	);

	html = html.replace(
		/<(\w+)([^>]*?\sdata-i18n-placeholder=)(["'])([^"']+)\3([^>]*)>/g,
		(m, tag, prefix, q, key, rest) => {
			const val = lookup(key);
			if (val === null) return m;
			const stripped = stripTags(val);
			let inner = prefix + q + key + q + rest;
			if (/\splaceholder=/.test(inner)) {
				inner = inner.replace(/\splaceholder=(["'])[^"']*\1/, ` placeholder="${escapeAttr(stripped)}"`);
			} else {
				inner += ` placeholder="${escapeAttr(stripped)}"`;
			}
			return `<${tag}${inner}>`;
		}
	);

	html = html.replace(
		/<(\w+)([^>]*?\sdata-i18n-alt=)(["'])([^"']+)\3([^>]*)>/g,
		(m, tag, prefix, q, key, rest) => {
			const val = lookup(key);
			if (val === null) return m;
			const stripped = stripTags(val);
			let inner = prefix + q + key + q + rest;
			if (/\salt=/.test(inner)) {
				inner = inner.replace(/\salt=(["'])[^"']*\1/, ` alt="${escapeAttr(stripped)}"`);
			} else {
				inner += ` alt="${escapeAttr(stripped)}"`;
			}
			return `<${tag}${inner}>`;
		}
	);

	html = html.replace(
		/<meta\b([^>]*?\sdata-i18n-content=)(["'])([^"']+)\2([^>]*)>/gi,
		(m, prefix, q, key, suffix) => {
			const val = lookup(key);
			if (val === null) return m;
			const stripped = stripTags(val);
			let attrs = prefix + q + key + q + suffix;
			if (/\scontent=/.test(attrs)) {
				attrs = attrs.replace(/\scontent=(["'])[^"']*\1/, ` content="${escapeAttr(stripped)}"`);
			} else {
				attrs += ` content="${escapeAttr(stripped)}"`;
			}
			return `<meta${attrs}>`;
		}
	);

	html = html.replace(
		/<title\b([^>]*?\sdata-i18n-title=)(["'])([^"']+)\2([^>]*)>([\s\S]*?)<\/title>/i,
		(m, prefix, q, key, suffix, content) => {
			const val = lookup(key);
			if (val === null) return m;
			return `<title${prefix}${q}${key}${q}${suffix}>${escapeAttr(stripTags(val))}</title>`;
		}
	);

	html = html.replace(
		/(<link[^>]*\brel=["']canonical["'][^>]*\bhref=)["']https?:\/\/[^"']*?["']/gi,
		(m, prefix) => {
			const orig = m.match(/href=["'](https?:\/\/[^"']+)["']/i);
			if (!orig) return m;
			const u = new URL(orig[1]);
			const newPath = (urlPrefix || '') + u.pathname;
			return `${prefix}"https://${u.host}${newPath}"`;
		}
	);

	html = html.replace(
		/(<meta[^>]*\bproperty=["']og:url["'][^>]*\bcontent=)["']https?:\/\/[^"']*?["']/gi,
		(m, prefix) => {
			const orig = m.match(/content=["'](https?:\/\/[^"']+)["']/i);
			if (!orig) return m;
			const u = new URL(orig[1]);
			const newPath = (urlPrefix || '') + u.pathname;
			return `${prefix}"https://${u.host}${newPath}"`;
		}
	);

	html = html.replace(
		/(<meta[^>]*\bproperty=["']og:locale["'][^>]*\bcontent=)["'][^"']*?["']/gi,
		(m, prefix) => `${prefix}"${ogLocale}"`
	);

	return html;
}

function injectHreflang(html, requestPath) {
	if (!/<\/head>/i.test(html)) return html;
	if (/hreflang=/.test(html)) return html;

	const langs = LANGS.filter(l => langStrings[l]);
	const tags = langs.map(l => {
		const prefix = l === 'tr' ? '' : '/' + l;
		return `\t<link rel="alternate" hreflang="${l}" href="https://cscommends.com${prefix}${requestPath}">`;
	}).join('\n');
	const xDefault = `\t<link rel="alternate" hreflang="x-default" href="https://cscommends.com${requestPath}">`;
	const block = '\n' + tags + '\n' + xDefault + '\n';

	return html.replace(/<\/head>/i, block + '</head>');
}

function renderLocalized(filePath, lang, requestPath) {
	if (!langStrings[lang] && lang !== 'tr') {
		lang = 'tr';
	}

	let stats;
	try { stats = fs.statSync(filePath); } catch { return null; }

	const cacheKey = filePath + '|' + lang + '|' + requestPath;
	const cached = cacheGet(cacheKey);
	if (cached && cached.mtime === stats.mtimeMs) {
		return cached.html;
	}

	let html;
	try { html = fs.readFileSync(filePath, 'utf8'); }
	catch { return null; }

	const urlPrefix = lang === 'tr' ? '' : '/' + lang;
	html = localizeHtml(html, lang, urlPrefix);
	html = injectHreflang(html, requestPath);

	cacheSet(cacheKey, { html, mtime: stats.mtimeMs });
	return html;
}

module.exports = {
	loadAllLangs,
	reloadLang,
	renderLocalized,
	getStrings,
	tr,
	LANGS,
	OG_LOCALES
};
