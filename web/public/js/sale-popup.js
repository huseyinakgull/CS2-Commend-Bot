(function () {
	'use strict';

	if (window.__csCommendsSaleMounted) return;
	window.__csCommendsSaleMounted = true;

	const STORAGE_KEY = 'cscom_sale_dismissed';
	const DISCORD_INVITE = 'https://discord.gg/K4G3RADfbc';

	const BLOCKED_PATHS = ['/admin', '/hitl', '/reseller', '/odeme-sonuc'];
	function isBlockedPath() {
		const p = (location.pathname || '').toLowerCase();
		const stripped = p.replace(/^\/(en|de|ru|pl|pt|es|fr)(?=\/|$)/, '') || '/';
		return BLOCKED_PATHS.some(b => stripped === b || stripped.startsWith(b + '/') || stripped.startsWith(b + '.'));
	}

	const SUPPORTED = ['tr', 'en', 'de', 'ru', 'pl', 'pt', 'es', 'fr'];
	const DEFAULT_LANG = 'tr';

	function detectLang() {
		const m = window.location.pathname.match(/^\/(en|de|ru|pl|pt|es|fr)(\/|$)/i);
		if (m) return m[1].toLowerCase();
		try {
			const stored = localStorage.getItem('cs_lang');
			if (stored && SUPPORTED.includes(stored)) return stored;
		} catch {}
		const nav = (navigator.language || '').toLowerCase();
		for (const l of SUPPORTED) if (nav.startsWith(l)) return l;
		return DEFAULT_LANG;
	}

	const I18N = {
		tr: {
			badge: 'Devren Satılık',
			title_prefix: '', title_accent: 'cscommends.com', title_suffix: ' satılıktır',
			lead: 'Kurulmuş, çalışan ve kâr eden bir CS2 övgü otomasyon sistemi devredilecektir. Ciddi alıcılar Discord üzerinden iletişime geçebilir.',
			items: [
				'Aktif müşteri havuzu ve düzenli sipariş akışı',
				'Kurulu Steam bot altyapısı, hazır sistem',
				'Domain + sunucu + tam kaynak kod',
				'Teknik devir + kısa süreli destek'
			],
			cta: "Discord'dan İletişime Geç",
			foot: 'Bu duyuru bu oturumda tekrar gösterilmeyecek.',
			close_label: 'Kapat'
		},
		en: {
			badge: 'Business For Sale',
			title_prefix: '', title_accent: 'cscommends.com', title_suffix: ' is for sale',
			lead: 'An established, running and profitable CS2 commend automation business is being transferred. Serious buyers may reach out via Discord.',
			items: [
				'Active customer base with steady order flow',
				'Ready-to-run Steam bot infrastructure',
				'Domain + server + full source code',
				'Technical handover + short-term support'
			],
			cta: 'Contact via Discord',
			foot: "This notice won't be shown again this session.",
			close_label: 'Close'
		},
		de: {
			badge: 'Zu Verkaufen',
			title_prefix: '', title_accent: 'cscommends.com', title_suffix: ' steht zum Verkauf',
			lead: 'Ein etabliertes, laufendes und profitables CS2 Commend-Automatisierungssystem wird übergeben. Ernsthafte Käufer können über Discord Kontakt aufnehmen.',
			items: [
				'Aktiver Kundenstamm mit stetigem Auftragsfluss',
				'Einsatzbereite Steam-Bot-Infrastruktur',
				'Domain + Server + vollständiger Quellcode',
				'Technische Übergabe + kurzfristige Unterstützung'
			],
			cta: 'Über Discord kontaktieren',
			foot: 'Diese Meldung wird in dieser Sitzung nicht erneut angezeigt.',
			close_label: 'Schließen'
		},
		ru: {
			badge: 'Продаётся Бизнес',
			title_prefix: '', title_accent: 'cscommends.com', title_suffix: ' продаётся',
			lead: 'Действующий, прибыльный сервис автоматизации похвал CS2 передаётся новому владельцу. Серьёзные покупатели — пишите в Discord.',
			items: [
				'Активная клиентская база и стабильный поток заказов',
				'Готовая инфраструктура Steam-ботов',
				'Домен + сервер + полный исходный код',
				'Технический перевод + краткосрочная поддержка'
			],
			cta: 'Связаться через Discord',
			foot: 'Это уведомление больше не появится в этой сессии.',
			close_label: 'Закрыть'
		},
		pl: {
			badge: 'Biznes na Sprzedaż',
			title_prefix: '', title_accent: 'cscommends.com', title_suffix: ' jest na sprzedaż',
			lead: 'Ustanowiony, działający i dochodowy system automatyzacji pochwał CS2 zostaje przekazany. Poważni kupujący mogą kontaktować się przez Discord.',
			items: [
				'Aktywna baza klientów i stały napływ zamówień',
				'Gotowa infrastruktura botów Steam',
				'Domena + serwer + pełny kod źródłowy',
				'Przekazanie techniczne + krótkoterminowe wsparcie'
			],
			cta: 'Skontaktuj się przez Discord',
			foot: 'To powiadomienie nie pojawi się ponownie w tej sesji.',
			close_label: 'Zamknij'
		},
		pt: {
			badge: 'Negócio à Venda',
			title_prefix: '', title_accent: 'cscommends.com', title_suffix: ' está à venda',
			lead: 'Um sistema estabelecido, funcional e lucrativo de automação de commends CS2 está sendo transferido. Compradores sérios podem entrar em contato pelo Discord.',
			items: [
				'Base de clientes ativa e fluxo constante de pedidos',
				'Infraestrutura de bots Steam pronta para uso',
				'Domínio + servidor + código-fonte completo',
				'Transferência técnica + suporte de curto prazo'
			],
			cta: 'Contatar via Discord',
			foot: 'Este aviso não será exibido novamente nesta sessão.',
			close_label: 'Fechar'
		},
		es: {
			badge: 'Negocio en Venta',
			title_prefix: '', title_accent: 'cscommends.com', title_suffix: ' está en venta',
			lead: 'Un sistema establecido, en funcionamiento y rentable de automatización de commends CS2 se transferirá. Los compradores serios pueden contactar por Discord.',
			items: [
				'Base de clientes activa con flujo constante de pedidos',
				'Infraestructura de bots Steam lista para usar',
				'Dominio + servidor + código fuente completo',
				'Transferencia técnica + soporte a corto plazo'
			],
			cta: 'Contactar por Discord',
			foot: 'Este aviso no se volverá a mostrar en esta sesión.',
			close_label: 'Cerrar'
		},
		fr: {
			badge: 'Entreprise à Vendre',
			title_prefix: '', title_accent: 'cscommends.com', title_suffix: ' est à vendre',
			lead: 'Un système établi, en activité et rentable d\'automatisation de commends CS2 sera cédé. Les acheteurs sérieux peuvent nous contacter via Discord.',
			items: [
				'Base de clients active avec flux régulier de commandes',
				'Infrastructure de bots Steam prête à l\'emploi',
				'Domaine + serveur + code source complet',
				'Transfert technique + support à court terme'
			],
			cta: 'Contacter via Discord',
			foot: 'Cet avis ne sera plus affiché lors de cette session.',
			close_label: 'Fermer'
		}
	};

	function escapeHtml(str) {
		return String(str || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	const STYLES = `
		.cscom-sale-overlay {
			position: fixed; inset: 0;
			background: rgba(4, 8, 20, 0.82);
			backdrop-filter: blur(6px);
			-webkit-backdrop-filter: blur(6px);
			z-index: 999999;
			display: flex; align-items: center; justify-content: center;
			padding: 20px;
			animation: cscomSaleFade 240ms ease-out;
			font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
		}
		.cscom-sale-modal {
			background: linear-gradient(155deg, #0f172a 0%, #1e293b 55%, #312e81 100%);
			color: #fff;
			max-width: 560px; width: 100%;
			border-radius: 20px;
			border: 1px solid rgba(148, 163, 184, 0.25);
			box-shadow: 0 30px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(99,102,241,0.15);
			padding: 36px 34px 30px;
			position: relative;
			animation: cscomSalePop 320ms cubic-bezier(.2,.9,.3,1.15);
		}
		.cscom-sale-close {
			position: absolute; top: 14px; right: 14px;
			background: rgba(255,255,255,0.08); color: #cbd5e1; border: 0;
			width: 34px; height: 34px; border-radius: 50%;
			font-size: 1.2rem; cursor: pointer;
			display: inline-flex; align-items: center; justify-content: center;
			transition: background .15s ease, color .15s ease;
		}
		.cscom-sale-close:hover { background: rgba(255,255,255,0.16); color: #fff; }
		.cscom-sale-badge {
			display: inline-block;
			background: linear-gradient(135deg, #f59e0b, #ef4444);
			color: #fff; font-weight: 800; font-size: 0.72rem;
			padding: 5px 12px; border-radius: 999px;
			letter-spacing: 1.1px; text-transform: uppercase;
			margin-bottom: 14px;
		}
		.cscom-sale-title {
			font-size: 1.55rem; font-weight: 800;
			margin: 0 0 10px 0; line-height: 1.25;
			letter-spacing: -0.3px;
		}
		.cscom-sale-title .accent {
			background: linear-gradient(135deg, #a78bfa, #60a5fa);
			-webkit-background-clip: text; background-clip: text;
			-webkit-text-fill-color: transparent; color: transparent;
		}
		.cscom-sale-lead {
			color: #cbd5e1; font-size: 0.98rem; line-height: 1.55;
			margin: 0 0 18px 0;
		}
		.cscom-sale-list {
			list-style: none; padding: 0; margin: 0 0 22px 0;
			display: grid; gap: 8px;
		}
		.cscom-sale-list li {
			display: flex; align-items: center; gap: 10px;
			color: #e2e8f0; font-size: 0.92rem;
		}
		.cscom-sale-list li::before {
			content: '✓'; color: #34d399; font-weight: 800;
			background: rgba(52, 211, 153, 0.12);
			width: 22px; height: 22px; border-radius: 50%;
			display: inline-flex; align-items: center; justify-content: center;
			flex-shrink: 0; font-size: 0.85rem;
		}
		.cscom-sale-cta {
			display: flex; align-items: center; justify-content: center;
			gap: 10px; width: 100%;
			background: linear-gradient(135deg, #5865F2, #4752c4);
			color: #fff; font-weight: 700; font-size: 1rem;
			border: 0; border-radius: 12px;
			padding: 14px 20px; cursor: pointer;
			text-decoration: none;
			box-shadow: 0 10px 25px rgba(88, 101, 242, 0.35);
			transition: transform .12s ease, box-shadow .18s ease;
		}
		.cscom-sale-cta:hover {
			transform: translateY(-1px);
			box-shadow: 0 14px 30px rgba(88, 101, 242, 0.5);
		}
		.cscom-sale-foot {
			text-align: center; color: #94a3b8;
			font-size: 0.78rem; margin: 14px 0 0 0;
		}
		@keyframes cscomSaleFade {
			from { opacity: 0; }
			to { opacity: 1; }
		}
		@keyframes cscomSalePop {
			from { transform: scale(0.94) translateY(10px); opacity: 0; }
			to   { transform: scale(1) translateY(0); opacity: 1; }
		}
		@media (max-width: 520px) {
			.cscom-sale-modal { padding: 28px 22px 24px; border-radius: 16px; }
			.cscom-sale-title { font-size: 1.3rem; }
			.cscom-sale-lead { font-size: 0.92rem; }
		}
	`;

	function injectStyles() {
		if (document.getElementById('cscom-sale-styles')) return;
		const s = document.createElement('style');
		s.id = 'cscom-sale-styles';
		s.textContent = STYLES;
		document.head.appendChild(s);
	}

	function isDismissed() {
		try { return sessionStorage.getItem(STORAGE_KEY) === '1'; }
		catch { return false; }
	}

	function markDismissed() {
		try { sessionStorage.setItem(STORAGE_KEY, '1'); } catch {}
	}

	function render() {
		if (isDismissed() || isBlockedPath()) return;
		if (document.getElementById('cscom-sale-overlay')) return;

		injectStyles();

		const lang = detectLang();
		const t = I18N[lang] || I18N[DEFAULT_LANG];

		const overlay = document.createElement('div');
		overlay.id = 'cscom-sale-overlay';
		overlay.className = 'cscom-sale-overlay';
		overlay.setAttribute('role', 'dialog');
		overlay.setAttribute('aria-modal', 'true');
		overlay.setAttribute('aria-labelledby', 'cscom-sale-title');
		overlay.setAttribute('lang', lang);

		const itemsHtml = t.items.map(x => `<li>${escapeHtml(x)}</li>`).join('');

		overlay.innerHTML = `
			<div class="cscom-sale-modal">
				<button class="cscom-sale-close" type="button" aria-label="${escapeHtml(t.close_label)}" title="${escapeHtml(t.close_label)}">×</button>
				<div class="cscom-sale-badge">${escapeHtml(t.badge)}</div>
				<h2 id="cscom-sale-title" class="cscom-sale-title">
					${escapeHtml(t.title_prefix)}<span class="accent">${escapeHtml(t.title_accent)}</span>${escapeHtml(t.title_suffix)}
				</h2>
				<p class="cscom-sale-lead">${escapeHtml(t.lead)}</p>
				<ul class="cscom-sale-list">${itemsHtml}</ul>
				<a class="cscom-sale-cta" href="${DISCORD_INVITE}" target="_blank" rel="noopener noreferrer">
					<span>💬</span>
					<span>${escapeHtml(t.cta)}</span>
				</a>
				<p class="cscom-sale-foot">${escapeHtml(t.foot)}</p>
			</div>
		`;

		function close() {
			markDismissed();
			overlay.style.transition = 'opacity 200ms ease';
			overlay.style.opacity = '0';
			setTimeout(() => overlay.remove(), 220);
		}

		overlay.querySelector('.cscom-sale-close').addEventListener('click', close);
		overlay.addEventListener('click', function (e) {
			if (e.target === overlay) close();
		});
		document.addEventListener('keydown', function onEsc(e) {
			if (e.key === 'Escape') {
				document.removeEventListener('keydown', onEsc);
				close();
			}
		});
		overlay.querySelector('.cscom-sale-cta').addEventListener('click', function () {
			markDismissed();
		});

		document.body.appendChild(overlay);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', render, { once: true });
	} else {
		render();
	}
})();
