(function() {
	'use strict';

	const FLAG_KEY = 'csc_tour_v1_done';
	const FORCE_QUERY = '?tour=1';

	function tr(key, fallback) {
		try {
			if (window.i18n && typeof window.i18n.t === 'function') {
				const v = window.i18n.t(key);
				return v && v !== key ? v : (fallback || key);
			}
		} catch {}
		return fallback || key;
	}

	const css = `
		#cscTour {
			position: fixed; inset: 0; z-index: 99990;
			pointer-events: none;
		}
		#cscTour.active { pointer-events: auto; }
		.csc-tour-backdrop {
			position: fixed; inset: 0;
			background: rgba(0,0,0,0.65);
			backdrop-filter: blur(2px);
			-webkit-backdrop-filter: blur(2px);
			opacity: 0; transition: opacity 0.25s;
			pointer-events: auto;
		}
		#cscTour.active .csc-tour-backdrop { opacity: 1; }
		.csc-tour-spotlight {
			position: absolute;
			border-radius: 12px;
			box-shadow: 0 0 0 9999px rgba(0,0,0,0.7), 0 0 0 4px #ff6b00, 0 0 24px rgba(255,107,0,0.55);
			pointer-events: none;
			transition: all 0.35s cubic-bezier(.4,.2,.2,1);
		}
		.csc-tour-card {
			position: absolute;
			background: rgba(20,20,28,0.97);
			color: #e5e5ea;
			border: 1px solid rgba(255,107,0,0.4);
			border-radius: 12px;
			padding: 16px 18px;
			max-width: 340px;
			min-width: 280px;
			box-shadow: 0 16px 48px rgba(0,0,0,0.5);
			font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
			pointer-events: auto;
			z-index: 100000;
			transition: all 0.3s ease;
		}
		.csc-tour-card .csc-tour-title {
			font-size: 1.05rem; font-weight: 700; margin: 0 0 0.5rem;
			color: #ff944d;
			display: flex; align-items: center; gap: 8px;
		}
		.csc-tour-card .csc-tour-body {
			font-size: 0.88rem; line-height: 1.55; margin: 0 0 0.9rem;
			color: #d0d0d6;
		}
		.csc-tour-card .csc-tour-progress {
			display: flex; gap: 4px; margin-bottom: 0.7rem;
		}
		.csc-tour-card .csc-tour-progress span {
			flex: 1; height: 3px; background: rgba(255,255,255,0.12);
			border-radius: 2px; transition: background 0.2s;
		}
		.csc-tour-card .csc-tour-progress span.active { background: #ff6b00; }
		.csc-tour-card .csc-tour-progress span.done   { background: rgba(255,107,0,0.5); }
		.csc-tour-card .csc-tour-actions {
			display: flex; gap: 8px; justify-content: space-between; align-items: center;
		}
		.csc-tour-card .csc-tour-skip {
			background: none; border: none; color: #8b8b95;
			cursor: pointer; font-size: 0.82rem; padding: 4px 8px;
			text-decoration: underline;
		}
		.csc-tour-card .csc-tour-skip:hover { color: #d0d0d6; }
		.csc-tour-card .csc-tour-nav {
			display: flex; gap: 6px;
		}
		.csc-tour-card .csc-tour-btn {
			background: #ff6b00; color: white; border: none;
			padding: 7px 14px; border-radius: 6px;
			cursor: pointer; font-weight: 600; font-size: 0.86rem;
			transition: background 0.15s;
		}
		.csc-tour-card .csc-tour-btn:hover { background: #ff8533; }
		.csc-tour-card .csc-tour-btn.secondary {
			background: rgba(255,255,255,0.08); color: #d0d0d6;
		}
		.csc-tour-card .csc-tour-btn.secondary:hover { background: rgba(255,255,255,0.14); }

		@media (max-width: 640px) {
			.csc-tour-card { max-width: 90vw; min-width: 0; left: 5vw !important; right: 5vw; }
		}
	`;

	const steps = [
		{
			selector: null,
			titleKey: 'tour.welcome_title', titleFb: '🎉 CS Commends\'e hoş geldin!',
			bodyKey:  'tour.welcome_body',  bodyFb:  'Sana sistemi 30 saniyede tanıtacağım. Bu rehber sadece bir kez gösterilir; istediğin zaman atlayabilirsin.',
			placement: 'center'
		},
		{
			selector: '#balanceDisplay',
			titleKey: 'tour.step1_t', titleFb: '💰 Bakiyen',
			bodyKey:  'tour.step1_b', bodyFb:  'Burada kalan kredin görünür. Her başarılı övgü 1 kredi düşer; eksik kalan miktar otomatik iade edilir.',
			placement: 'bottom-left'
		},
		{
			selector: '#steamIdInput',
			titleKey: 'tour.step2_t', titleFb: '🎯 Hedef oyuncuyu gir',
			bodyKey:  'tour.step2_b', bodyFb:  'Steam profil URL\'sini buraya yapıştır. Sistem otomatik doğrular. Oyuncunun bizim sunucumuza katılmış olması gerekir.',
			placement: 'bottom'
		},
		{
			selector: '#amountInput',
			titleKey: 'tour.step3_t', titleFb: '🔢 Miktarı seç',
			bodyKey:  'tour.step3_b', bodyFb:  'Kaç adet övgü göndermek istediğini gir. Her övgü için Steam tarafından 1 kredi düşülür. Bütçenden fazla gönderemezsin.',
			placement: 'bottom'
		},
		{
			selector: '#sysHealthBadge',
			titleKey: 'tour.step4_t', titleFb: '💚 Sistem durumu',
			bodyKey:  'tour.step4_b', bodyFb:  'Sağ alttaki yeşil nokta sistemin canlı olduğunu gösterir. Sarı/kırmızı görürsen sistem geçici yavaşlama veya bakım durumunda — bekle veya Discord\'dan bilgi al.',
			placement: 'top-left'
		},
		{
			selector: '#historyTable',
			titleKey: 'tour.step5_t', titleFb: '📋 Geçmiş işlemler',
			bodyKey:  'tour.step5_b', bodyFb:  'Geçmiş siparişlerin burada listelenir. Üzerine tıklayarak detay (iade miktarı, sebep, açıklama) görebilirsin. Sorun çıkarsa "Bunu ne yapmalı?" rehberi otomatik açılır.',
			placement: 'top'
		}
	];

	let currentStep = 0;
	let overlayEl = null, cardEl = null, spotEl = null;
	let onResize = null;

	function makeOverlay() {
		const style = document.createElement('style');
		style.id = 'cscTour-css';
		style.textContent = css;
		document.head.appendChild(style);

		overlayEl = document.createElement('div');
		overlayEl.id = 'cscTour';
		overlayEl.innerHTML = `
			<div class="csc-tour-backdrop"></div>
			<div class="csc-tour-spotlight"></div>
			<div class="csc-tour-card" role="dialog" aria-modal="true" aria-labelledby="cscTourTitle">
				<div class="csc-tour-progress" id="cscTourProgress"></div>
				<h3 class="csc-tour-title" id="cscTourTitle">—</h3>
				<p class="csc-tour-body" id="cscTourBody">—</p>
				<div class="csc-tour-actions">
					<button class="csc-tour-skip" id="cscTourSkip">${tr('tour.skip', 'Atla')}</button>
					<div class="csc-tour-nav">
						<button class="csc-tour-btn secondary" id="cscTourPrev" hidden>${tr('tour.prev', 'Geri')}</button>
						<button class="csc-tour-btn" id="cscTourNext">${tr('tour.start', 'Başla')}</button>
					</div>
				</div>
			</div>
		`;
		document.body.appendChild(overlayEl);

		cardEl = overlayEl.querySelector('.csc-tour-card');
		spotEl = overlayEl.querySelector('.csc-tour-spotlight');

		overlayEl.querySelector('#cscTourSkip').addEventListener('click', endTour);
		overlayEl.querySelector('#cscTourBackdrop' );
		overlayEl.querySelector('.csc-tour-backdrop').addEventListener('click', (e) => {
			if (e.target === e.currentTarget) endTour();
		});
		overlayEl.querySelector('#cscTourPrev').addEventListener('click', prevStep);
		overlayEl.querySelector('#cscTourNext').addEventListener('click', nextStep);

		onResize = () => renderStep();
		window.addEventListener('resize', onResize);

		document.addEventListener('keydown', escHandler);
	}

	function escHandler(e) { if (e.key === 'Escape') endTour(); }

	function renderProgress() {
		const wrap = overlayEl.querySelector('#cscTourProgress');
		wrap.innerHTML = '';
		for (let i = 0; i < steps.length; i++) {
			const dot = document.createElement('span');
			if (i < currentStep) dot.className = 'done';
			else if (i === currentStep) dot.className = 'active';
			wrap.appendChild(dot);
		}
	}

	function renderStep() {
		if (!overlayEl) return;
		const s = steps[currentStep];
		if (!s) { endTour(); return; }

		overlayEl.classList.add('active');
		renderProgress();
		overlayEl.querySelector('#cscTourTitle').textContent = tr(s.titleKey, s.titleFb);
		overlayEl.querySelector('#cscTourBody').textContent = tr(s.bodyKey, s.bodyFb);

		const prevBtn = overlayEl.querySelector('#cscTourPrev');
		const nextBtn = overlayEl.querySelector('#cscTourNext');
		prevBtn.hidden = currentStep === 0;
		nextBtn.textContent = currentStep === 0
			? tr('tour.start', 'Başla')
			: currentStep === steps.length - 1
				? tr('tour.done', 'Bitti')
				: tr('tour.next', 'İleri');

		positionFor(s);
	}

	function positionFor(s) {
		let target = null;
		if (s.selector) target = document.querySelector(s.selector);

		if (!target || s.placement === 'center') {
			spotEl.style.display = 'none';
			cardEl.style.left = '50%';
			cardEl.style.top = '50%';
			cardEl.style.transform = 'translate(-50%, -50%)';
			return;
		}

		const r = target.getBoundingClientRect();
		if (r.top < 0 || r.bottom > window.innerHeight) {
			target.scrollIntoView({ behavior: 'smooth', block: 'center' });
			setTimeout(() => positionFor(s), 350);
			return;
		}

		spotEl.style.display = 'block';
		const pad = 8;
		spotEl.style.left   = (r.left - pad) + 'px';
		spotEl.style.top    = (r.top - pad) + 'px';
		spotEl.style.width  = (r.width + pad * 2) + 'px';
		spotEl.style.height = (r.height + pad * 2) + 'px';

		const cardW = 340, cardH = cardEl.offsetHeight || 200;
		cardEl.style.transform = 'none';

		let left, top;
		switch (s.placement) {
			case 'bottom':
				left = Math.max(12, Math.min(r.left + r.width / 2 - cardW / 2, window.innerWidth - cardW - 12));
				top  = r.bottom + 16;
				break;
			case 'bottom-left':
				left = Math.max(12, r.left);
				top  = r.bottom + 16;
				break;
			case 'top':
				left = Math.max(12, Math.min(r.left + r.width / 2 - cardW / 2, window.innerWidth - cardW - 12));
				top  = r.top - cardH - 16;
				break;
			case 'top-left':
				left = Math.max(12, r.left - cardW - 16);
				top  = Math.max(12, r.top - cardH - 16);
				break;
			default:
				left = r.right + 16;
				top  = r.top;
		}

		if (top + cardH > window.innerHeight - 12) top = window.innerHeight - cardH - 12;
		if (top < 12) top = 12;
		if (left + cardW > window.innerWidth - 12) left = window.innerWidth - cardW - 12;
		if (left < 12) left = 12;

		cardEl.style.left = left + 'px';
		cardEl.style.top  = top + 'px';
	}

	function nextStep() {
		if (currentStep >= steps.length - 1) { endTour(); return; }
		currentStep++;
		renderStep();
	}
	function prevStep() {
		if (currentStep === 0) return;
		currentStep--;
		renderStep();
	}

	function endTour() {
		try { localStorage.setItem(FLAG_KEY, '1'); } catch {}
		if (overlayEl) {
			overlayEl.remove();
			overlayEl = null;
		}
		if (onResize) window.removeEventListener('resize', onResize);
		document.removeEventListener('keydown', escHandler);
		try {
			if (location.search.indexOf('tour=1') >= 0) {
				const u = new URL(location.href);
				u.searchParams.delete('tour');
				history.replaceState({}, '', u.toString());
			}
		} catch {}
	}

	function shouldRunAuto() {
		try {
			if (location.search.indexOf('tour=1') >= 0) return true;
			if (localStorage.getItem(FLAG_KEY) === '1') return false;
		} catch { return false; }
		if (!document.getElementById('balanceDisplay')) return false;
		return true;
	}

	function start() {
		currentStep = 0;
		if (!overlayEl) makeOverlay();
		renderStep();
	}

	window.__startOnboardingTour = start;

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', () => setTimeout(() => { if (shouldRunAuto()) start(); }, 1500));
	} else {
		setTimeout(() => { if (shouldRunAuto()) start(); }, 1500);
	}

	window.addEventListener('langchange', () => {
		if (overlayEl) renderStep();
	});
})();
