(function() {
	'use strict';

	const opts = window.__SYS_BADGE_OPTS || {};
	const POLL_MS = 60 * 1000;
	const FAIL_BACKOFF_MS = 120 * 1000;

	function tr(key, fallback) {
		try {
			if (window.i18n && typeof window.i18n.t === 'function') {
				const v = window.i18n.t(key);
				return v && v !== key ? v : (fallback || key);
			}
		} catch {}
		return fallback || key;
	}

	function buildBadge() {
		const wrap = document.createElement('div');
		wrap.id = 'sysHealthBadge';
		wrap.setAttribute('role', 'status');
		wrap.setAttribute('aria-live', 'polite');
		wrap.innerHTML = `
			<div class="shb-pill" role="button" tabindex="0" aria-expanded="false">
				<span class="shb-dot"></span>
				<span class="shb-label">...</span>
				<svg class="shb-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 9 12 15 6 9"/></svg>
			</div>
			<div class="shb-panel" hidden>
				<div class="shb-panel-row" data-row="proxies">
					<span class="shb-icon">🌐</span><span class="shb-row-label" data-i18n-key="sysbadge.proxy_ok">Proxy</span><span class="shb-row-status">—</span>
				</div>
				<div class="shb-panel-row" data-row="rcon">
					<span class="shb-icon">🖥️</span><span class="shb-row-label" data-i18n-key="sysbadge.rcon_ok">Sunucu</span><span class="shb-row-status">—</span>
				</div>
				<div class="shb-panel-row" data-row="bots">
					<span class="shb-icon">🤖</span><span class="shb-row-label" data-i18n-key="sysbadge.bots_ok">Bot havuzu</span><span class="shb-row-status">—</span>
				</div>
				<div class="shb-panel-meta">
					<span data-i18n-key="sysbadge.last_check">Son kontrol</span>: <span class="shb-last-check">—</span>
				</div>
			</div>`;

		const css = document.createElement('style');
		css.id = 'sysHealthBadge-css';
		css.textContent = `
			#sysHealthBadge {
				position: fixed; bottom: 14px; right: 14px; z-index: 9998;
				font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
				font-size: 12px;
				user-select: none;
			}
			#sysHealthBadge .shb-pill {
				display: inline-flex; align-items: center; gap: 8px;
				padding: 6px 11px;
				background: rgba(20, 20, 28, 0.92);
				color: #d4d4dc;
				border: 1px solid rgba(255, 255, 255, 0.12);
				border-radius: 100px;
				cursor: pointer;
				transition: transform 0.15s, background 0.15s, border-color 0.15s;
				backdrop-filter: blur(8px);
				-webkit-backdrop-filter: blur(8px);
				box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
			}
			#sysHealthBadge .shb-pill:hover { transform: translateY(-1px); background: rgba(28, 28, 38, 0.95); }
			#sysHealthBadge .shb-pill:focus { outline: 2px solid #ff6b00; outline-offset: 2px; }
			#sysHealthBadge .shb-dot {
				width: 7px; height: 7px; border-radius: 50%;
				background: #888;
				flex-shrink: 0;
			}
			#sysHealthBadge.s-ok .shb-dot { background: #2ecc71; box-shadow: 0 0 8px rgba(46, 204, 113, 0.6); animation: shbPulse 2.4s infinite; }
			#sysHealthBadge.s-degraded .shb-dot { background: #ffaa00; box-shadow: 0 0 8px rgba(255, 170, 0, 0.6); animation: shbPulse 1.6s infinite; }
			#sysHealthBadge.s-maintenance .shb-dot { background: #4d9de0; box-shadow: 0 0 8px rgba(77, 157, 224, 0.6); }
			#sysHealthBadge.s-offline .shb-dot { background: #ff4444; box-shadow: 0 0 8px rgba(255, 68, 68, 0.6); animation: shbPulse 1s infinite; }
			@keyframes shbPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
			#sysHealthBadge .shb-label { white-space: nowrap; font-weight: 600; letter-spacing: 0.01em; }
			#sysHealthBadge.s-ok .shb-label { color: #88e7ad; }
			#sysHealthBadge.s-degraded .shb-label { color: #ffd380; }
			#sysHealthBadge.s-maintenance .shb-label { color: #a5c8e8; }
			#sysHealthBadge.s-offline .shb-label { color: #ff8e8e; }
			#sysHealthBadge .shb-caret { opacity: 0.55; transition: transform 0.18s; }
			#sysHealthBadge.open .shb-caret { transform: rotate(180deg); }
			#sysHealthBadge .shb-panel {
				margin-top: 6px;
				background: rgba(16, 16, 24, 0.97);
				border: 1px solid rgba(255, 255, 255, 0.12);
				border-radius: 8px;
				padding: 10px 12px;
				min-width: 220px;
				box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
				color: #d4d4dc;
				backdrop-filter: blur(8px);
				-webkit-backdrop-filter: blur(8px);
			}
			#sysHealthBadge .shb-panel[hidden] { display: none; }
			#sysHealthBadge .shb-panel-row {
				display: grid; grid-template-columns: 18px 1fr auto;
				align-items: center; gap: 8px;
				padding: 4px 0;
				font-size: 12px;
			}
			#sysHealthBadge .shb-icon { font-size: 13px; line-height: 1; text-align: center; }
			#sysHealthBadge .shb-row-label { color: #c0c0c8; }
			#sysHealthBadge .shb-row-status { font-weight: 600; font-size: 11px; }
			#sysHealthBadge .shb-row-status.ok { color: #2ecc71; }
			#sysHealthBadge .shb-row-status.low { color: #ffaa00; }
			#sysHealthBadge .shb-row-status.fail { color: #ff4444; }
			#sysHealthBadge .shb-panel-meta {
				margin-top: 6px; padding-top: 6px;
				border-top: 1px dashed rgba(255, 255, 255, 0.08);
				font-size: 10.5px; color: #888;
				text-align: right;
			}
			@media (max-width: 640px) {
				#sysHealthBadge { bottom: 8px; right: 8px; }
				#sysHealthBadge .shb-pill { padding: 5px 9px; font-size: 11px; }
				#sysHealthBadge .shb-panel { right: 0; min-width: 200px; }
			}
		`;
		document.head.appendChild(css);
		document.body.appendChild(wrap);
		return wrap;
	}

	const root = buildBadge();
	const pill = root.querySelector('.shb-pill');
	const panel = root.querySelector('.shb-panel');
	const labelEl = root.querySelector('.shb-label');
	const lastCheckEl = root.querySelector('.shb-last-check');

	function togglePanel(open) {
		const willOpen = open === undefined ? panel.hasAttribute('hidden') : open;
		if (willOpen) {
			panel.removeAttribute('hidden');
			root.classList.add('open');
			pill.setAttribute('aria-expanded', 'true');
		} else {
			panel.setAttribute('hidden', '');
			root.classList.remove('open');
			pill.setAttribute('aria-expanded', 'false');
		}
	}
	pill.addEventListener('click', () => togglePanel());
	pill.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel(); }
		if (e.key === 'Escape') togglePanel(false);
	});

	function render(data) {
		const overall = data && data.overall || 'offline';
		root.className = '';
		root.classList.add('s-' + overall);

		const labelKey = overall === 'ok' ? 'sysbadge.all_ok'
		               : overall === 'degraded' ? 'sysbadge.degraded'
		               : overall === 'maintenance' ? 'sysbadge.maintenance'
		               : 'sysbadge.offline';
		const labelFallback = overall === 'ok' ? 'Tüm sistemler aktif'
		                    : overall === 'degraded' ? 'Bazı sistemler yavaş'
		                    : overall === 'maintenance' ? 'Bakım modunda'
		                    : 'Sistem çevrimdışı';
		labelEl.textContent = tr(labelKey, labelFallback);

		const sub = (data && data.subsystems) || {};
		setRowStatus('proxies', sub.proxies);
		setRowStatus('rcon', sub.rcon);
		setRowStatus('bots', sub.bots);

		if (data && data.lastCheck) {
			const d = new Date(data.lastCheck);
			lastCheckEl.textContent = d.toLocaleTimeString();
		}
	}

	function setRowStatus(row, status) {
		const el = root.querySelector(`.shb-panel-row[data-row="${row}"] .shb-row-status`);
		if (!el) return;
		const s = (status || 'fail').toLowerCase();
		el.className = 'shb-row-status ' + s;
		el.textContent = s === 'ok' ? '●' : s === 'low' ? '◐' : '✕';
	}

	let pollTimer = null;
	async function refresh() {
		try {
			const r = await fetch('/api/system-health', { cache: 'no-store' });
			if (!r.ok) throw new Error('HTTP ' + r.status);
			const data = await r.json();
			render(data);
			pollTimer = setTimeout(refresh, POLL_MS);
		} catch (err) {
			render({ overall: 'offline', subsystems: {}, lastCheck: new Date().toISOString() });
			pollTimer = setTimeout(refresh, FAIL_BACKOFF_MS);
		}
	}

	refresh();
	window.addEventListener('focus', () => {
		if (pollTimer) clearTimeout(pollTimer);
		refresh();
	});
	window.addEventListener('langchange', () => {
		if (root.classList.contains('s-ok'))         labelEl.textContent = tr('sysbadge.all_ok', 'Tüm sistemler aktif');
		else if (root.classList.contains('s-degraded')) labelEl.textContent = tr('sysbadge.degraded', 'Bazı sistemler yavaş');
		else if (root.classList.contains('s-maintenance')) labelEl.textContent = tr('sysbadge.maintenance', 'Bakım modunda');
		else if (root.classList.contains('s-offline'))  labelEl.textContent = tr('sysbadge.offline', 'Sistem çevrimdışı');

		const proxyLbl = root.querySelector('[data-row="proxies"] .shb-row-label');
		const rconLbl = root.querySelector('[data-row="rcon"] .shb-row-label');
		const botsLbl = root.querySelector('[data-row="bots"] .shb-row-label');
		if (proxyLbl) proxyLbl.textContent = tr('sysbadge.proxy_ok', 'Proxy');
		if (rconLbl) rconLbl.textContent = tr('sysbadge.rcon_ok', 'Sunucu');
		if (botsLbl) botsLbl.textContent = tr('sysbadge.bots_ok', 'Bot havuzu');
		const metaLbl = root.querySelector('.shb-panel-meta span:first-child');
		if (metaLbl) metaLbl.textContent = tr('sysbadge.last_check', 'Son kontrol');
	});
})();
