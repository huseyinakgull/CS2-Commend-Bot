(function () {
	'use strict';

	if (window.__csCommendsAnnouncementMounted) return;
	window.__csCommendsAnnouncementMounted = true;

	const STORAGE_KEY = 'cscom_ann_dismissed_v';
	const REFRESH_MS = 5 * 60 * 1000;

	const STYLES = `
		.cscom-ann {
			width: 100%;
			padding: 14px 18px;
			color: #fff;
			font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
			font-size: 0.95rem;
			line-height: 1.45;
			box-sizing: border-box;
			position: relative;
			z-index: 9999;
			animation: cscomAnnSlide 320ms cubic-bezier(.2,.7,.3,1);
		}
		.cscom-ann-inner {
			max-width: 1180px; margin: 0 auto;
			display: flex; gap: 14px; align-items: flex-start;
		}
		.cscom-ann-icon { font-size: 1.6rem; line-height: 1; flex-shrink: 0; }
		.cscom-ann-body { flex: 1; min-width: 0; }
		.cscom-ann-title {
			font-weight: 800; font-size: 1.05rem; letter-spacing: 0.2px;
			margin: 0 0 4px 0;
		}
		.cscom-ann-text {
			font-weight: 500; opacity: 0.95;
			white-space: pre-wrap; word-break: break-word;
		}
		.cscom-ann-text a {
			color: #fff; text-decoration: underline; text-underline-offset: 2px;
			font-weight: 700;
		}
		.cscom-ann-close {
			background: rgba(0,0,0,0.18); color: #fff; border: 0;
			width: 32px; height: 32px; border-radius: 50%;
			font-size: 1.1rem; cursor: pointer; flex-shrink: 0;
			display: inline-flex; align-items: center; justify-content: center;
			transition: background .15s ease;
		}
		.cscom-ann-close:hover { background: rgba(0,0,0,0.32); }

		.cscom-ann-info {
			background: linear-gradient(135deg, #1e3a8a 0%, #2563eb 100%);
			border-bottom: 2px solid #3b82f6;
		}
		.cscom-ann-warn {
			background: linear-gradient(135deg, #78350f 0%, #d97706 100%);
			border-bottom: 2px solid #fbbf24;
		}
		.cscom-ann-critical {
			background: linear-gradient(135deg, #7f1d1d 0%, #dc2626 100%);
			border-bottom: 2px solid #f87171;
			animation: cscomAnnPulse 2.4s ease-in-out infinite, cscomAnnSlide 320ms cubic-bezier(.2,.7,.3,1);
		}
		@keyframes cscomAnnPulse {
			0%, 100% { box-shadow: inset 0 0 0 0 rgba(255,255,255,0); }
			50% { box-shadow: inset 0 -3px 0 0 rgba(255,255,255,0.35); }
		}
		@keyframes cscomAnnSlide {
			from { transform: translateY(-100%); opacity: 0; }
			to   { transform: translateY(0); opacity: 1; }
		}
		@media (max-width: 640px) {
			.cscom-ann { padding: 12px 14px; font-size: 0.88rem; }
			.cscom-ann-title { font-size: 0.98rem; }
			.cscom-ann-icon { font-size: 1.3rem; }
		}
	`;

	function escapeHtml(str) {
		return String(str || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	function linkify(escapedText) {
		return escapedText.replace(
			/(https?:\/\/[^\s<]+)/g,
			'<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
		);
	}

	function injectStyles() {
		if (document.getElementById('cscom-ann-styles')) return;
		const s = document.createElement('style');
		s.id = 'cscom-ann-styles';
		s.textContent = STYLES;
		document.head.appendChild(s);
	}

	function getIcon(level) {
		if (level === 'critical') return '🚨';
		if (level === 'warn') return '⚠️';
		return 'ℹ️';
	}

	function render(ann) {
		const existing = document.getElementById('cscom-ann-banner');
		if (existing) existing.remove();

		if (!ann || !ann.active) return;

		const dismissedKey = ann.updatedAt || (ann.title + ann.body);
		try {
			if (localStorage.getItem(STORAGE_KEY) === dismissedKey) return;
		} catch {}

		const wrap = document.createElement('div');
		wrap.id = 'cscom-ann-banner';
		wrap.className = 'cscom-ann cscom-ann-' + (ann.level || 'info');
		wrap.setAttribute('role', 'alert');
		wrap.setAttribute('aria-live', 'polite');

		const titleHtml = ann.title ? `<div class="cscom-ann-title">${escapeHtml(ann.title)}</div>` : '';
		const bodyHtml = ann.body ? `<div class="cscom-ann-text">${linkify(escapeHtml(ann.body))}</div>` : '';

		wrap.innerHTML = `
			<div class="cscom-ann-inner">
				<span class="cscom-ann-icon" aria-hidden="true">${getIcon(ann.level)}</span>
				<div class="cscom-ann-body">
					${titleHtml}
					${bodyHtml}
				</div>
				<button class="cscom-ann-close" type="button" aria-label="Duyuruyu kapat" title="Kapat">×</button>
			</div>
		`;

		wrap.querySelector('.cscom-ann-close').addEventListener('click', function () {
			try { localStorage.setItem(STORAGE_KEY, dismissedKey); } catch {}
			wrap.style.transition = 'transform 220ms ease, opacity 220ms ease';
			wrap.style.transform = 'translateY(-100%)';
			wrap.style.opacity = '0';
			setTimeout(() => wrap.remove(), 240);
		});

		document.body.insertBefore(wrap, document.body.firstChild);
	}

	async function fetchAnnouncement() {
		try {
			const r = await fetch('/api/announcement?_=' + Date.now(), {
				credentials: 'same-origin',
				cache: 'no-store'
			});
			if (!r.ok) return null;
			return await r.json();
		} catch {
			return null;
		}
	}

	async function load() {
		const ann = await fetchAnnouncement();
		injectStyles();
		render(ann);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', load, { once: true });
	} else {
		load();
	}
	setInterval(load, REFRESH_MS);
})();
