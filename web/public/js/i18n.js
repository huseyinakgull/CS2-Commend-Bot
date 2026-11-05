(function () {
	'use strict';

	const SUPPORTED = ['tr', 'en', 'de', 'ru', 'pl', 'pt', 'es', 'fr'];
	const DEFAULT = 'tr';
	const STORAGE_KEY = 'cs_lang';

	let current = DEFAULT;
	let strings = {};

	function detectLang() {
		const pathMatch = window.location.pathname.match(/^\/(en|de|ru|pl|pt|es|fr)(\/|$)/i);
		if (pathMatch) return pathMatch[1].toLowerCase();

		const url = new URLSearchParams(window.location.search).get('lang');
		if (url && SUPPORTED.includes(url)) return url;

		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored && SUPPORTED.includes(stored)) return stored;

		const nav = (navigator.language || navigator.userLanguage || '').toLowerCase();
		for (const lang of SUPPORTED) {
			if (nav.startsWith(lang)) return lang;
		}

		return DEFAULT;
	}

	function rewriteLinks(targetLang) {
		const prefix = targetLang === DEFAULT ? '' : '/' + targetLang;
		const anchors = document.querySelectorAll('a[href^="/"]');
		anchors.forEach(a => {
			const href = a.getAttribute('href');
			if (/^\/(en|de|ru|pl|pt|es|fr)(\/|$)/.test(href)) return;
			if (/^\/(api|css|js|lang|img|favicon|logo|apple-touch|manifest|robots|sitemap)/.test(href)) return;
			if (href === '/' || /\.\w+$/.test(href)) {
				if (href === '/' && prefix) {
					a.setAttribute('href', prefix + '/');
				}
				return;
			}
			a.setAttribute('href', prefix + href);
		});
	}

	async function loadLang(lang) {
		try {
			const r = await fetch('/lang/' + lang + '.json', { cache: 'no-cache' });
			if (!r.ok) throw new Error(r.status);
			return await r.json();
		} catch {
			if (lang !== DEFAULT) return loadLang(DEFAULT);
			return {};
		}
	}

	function applyDOM() {
		document.querySelectorAll('[data-i18n]').forEach(el => {
			const key = el.getAttribute('data-i18n');
			if (strings[key] !== undefined) {
				if (strings[key].includes('&') || strings[key].includes('<')) {
					el.innerHTML = strings[key];
				} else {
					el.textContent = strings[key];
				}
			}
		});

		document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
			const key = el.getAttribute('data-i18n-placeholder');
			if (strings[key] !== undefined) el.placeholder = strings[key];
		});

		document.querySelectorAll('[data-i18n-alt]').forEach(el => {
			const key = el.getAttribute('data-i18n-alt');
			if (strings[key] !== undefined) el.alt = strings[key];
		});

		document.documentElement.lang = strings.lang || current;
		if (strings.dir) document.documentElement.dir = strings.dir;
	}

	const i18n = {
		lang: () => current,
		supported: () => SUPPORTED,

		t(key) {
			return strings[key] || key;
		},

		async setLang(lang) {
			if (!SUPPORTED.includes(lang)) return;
			localStorage.setItem(STORAGE_KEY, lang);

			const currentPath = window.location.pathname;
			const stripped = currentPath.replace(/^\/(en|de|ru|pl|pt|es|fr)(\/|$)/, '/');
			const newPath = lang === DEFAULT ? stripped : '/' + lang + (stripped === '/' ? '/' : stripped);
			if (newPath !== currentPath) {
				window.location.href = newPath + window.location.search + window.location.hash;
				return;
			}

			current = lang;
			strings = await loadLang(lang);
			applyDOM();
			document.querySelectorAll('[data-lang-switch]').forEach(el => {
				el.classList.toggle('active', el.getAttribute('data-lang-switch') === lang);
			});
			window.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
		},

		async init() {
			current = detectLang();
			strings = await loadLang(current);
			applyDOM();
			rewriteLinks(current);
			document.querySelectorAll('[data-lang-switch]').forEach(el => {
				el.classList.toggle('active', el.getAttribute('data-lang-switch') === current);
				el.addEventListener('click', () => i18n.setLang(el.getAttribute('data-lang-switch')));
			});
		}
	};

	window.i18n = i18n;

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', () => i18n.init());
	} else {
		i18n.init();
	}
})();
