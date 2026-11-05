(function () {
	'use strict';

	let lastStatus = null;
	let pollTimer = null;

	function getToken() {
		return localStorage.getItem('adminToken') || sessionStorage.getItem('adminToken') || '';
	}

	function authFetch(url, opts = {}) {
		const tok = getToken();
		const headers = Object.assign(
			{ 'Content-Type': 'application/json' },
			opts.headers || {},
			tok ? { Authorization: 'Bearer ' + tok } : {}
		);
		return fetch(url, Object.assign({}, opts, { headers }));
	}

	const btn = document.getElementById('gamesatisBtn');
	const dot = document.getElementById('gamesatisStateDot');
	const stateLbl = document.getElementById('gamesatisStateLabel');
	const modal = document.getElementById('modalOverlay');
	const modalContent = document.getElementById('modalContent');

	if (!btn) return;

	const STATE_COLOR = {
		idle:         { bg: '#6b7280', text: 'idle' },
		launching:    { bg: '#facc15', text: 'launching' },
		working:      { bg: '#60a5fa', text: 'working' },
		ready:        { bg: '#4ade80', text: 'ready' },
		needs_action: { bg: '#fb923c', text: 'müdahale!' },
		error:        { bg: '#f87171', text: 'error' }
	};

	function escHtml(s) {
		return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
	}

	function fmtRel(iso) {
		if (!iso) return '—';
		try {
			const d = new Date(iso);
			const diff = (Date.now() - d.getTime()) / 1000;
			if (diff < 60) return Math.round(diff) + 's önce';
			if (diff < 3600) return Math.round(diff / 60) + 'dk önce';
			if (diff < 86400) return Math.round(diff / 3600) + 'sa önce';
			return d.toLocaleString('tr-TR');
		} catch { return iso; }
	}

	function applyStatus(s) {
		lastStatus = s;
		const c = STATE_COLOR[s.state] || STATE_COLOR.idle;
		dot.style.background = c.bg;
		dot.style.boxShadow = `0 0 8px ${c.bg}`;
		btn.title = `Gamesatis · ${c.text}${s.lastError ? ' · ' + s.lastError : ''}`;
		stateLbl.textContent = c.text;
		stateLbl.classList.remove('hidden');
	}

	async function loadStatus() {
		try {
			const r = await authFetch('/api/admin/gamesatis/status');
			if (!r.ok) return;
			const s = await r.json();
			applyStatus(s);
			if (modal.classList.contains('active') && modalContent.querySelector('[data-gamesatis-modal]')) {
				renderModal();
			}
		} catch {}
	}

	function toast(msg, kind = 'info') {
		const c = document.getElementById('toast-container');
		if (!c) return;
		const t = document.createElement('div');
		t.className = `toast toast-${kind} fade-in`;
		t.textContent = msg;
		c.appendChild(t);
		setTimeout(() => t.remove(), 4000);
	}

	function renderModal() {
		const s = lastStatus || { state: 'unknown' };
		const color = STATE_COLOR[s.state] || STATE_COLOR.idle;

		const headlessNote = s.headless
			? '<span class="text-xs text-gray-500">headless mode</span>'
			: '<span class="text-xs text-yellow-400">⚠ headless=false (görünür browser)</span>';

		modalContent.innerHTML = `
			<div class="p-6" data-gamesatis-modal>
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-xl font-bold flex items-center gap-3">
						Gamesatis Otomasyonu
						<span class="status-pill" style="background:${color.bg}22;color:${color.bg};">
							<span style="background:${color.bg};"></span>${escHtml(color.text)}
						</span>
					</h2>
					<button onclick="window.closeModal&&window.closeModal()" class="text-gray-400 hover:text-white text-2xl">×</button>
				</div>

				<div class="grid grid-cols-2 gap-3 mb-4">
					<div class="stat-card">
						<div class="stat-label">Email</div>
						<div class="text-sm font-mono">${escHtml(s.email || '—')}</div>
					</div>
					<div class="stat-card">
						<div class="stat-label">Internal Token</div>
						<div class="text-sm">${s.internalTokenSet ? '<span class="text-green-400">✓ tanımlı</span>' : '<span class="text-red-400">✗ eksik</span>'}</div>
					</div>
					<div class="stat-card">
						<div class="stat-label">Browser</div>
						<div class="text-sm">${s.browserLaunched ? '<span class="text-blue-400">açık</span>' : '<span class="text-gray-500">kapalı</span>'} ${headlessNote}</div>
					</div>
					<div class="stat-card">
						<div class="stat-label">Session</div>
						<div class="text-sm">${s.sessionAlive == null ? '<span class="text-gray-500">bilinmiyor</span>' : (s.sessionAlive ? '<span class="text-green-400">aktif</span>' : '<span class="text-red-400">yok</span>')}</div>
						<div class="stat-sub">${fmtRel(s.sessionLastChecked)}</div>
					</div>
					<div class="stat-card">
						<div class="stat-label">Son Aksiyon</div>
						<div class="text-sm">${escHtml(s.lastAction || '—')}</div>
						<div class="stat-sub">${fmtRel(s.lastActionAt)}</div>
					</div>
					<div class="stat-card">
						<div class="stat-label">Mevcut İşlem</div>
						<div class="text-sm">${s.busy ? `<span class="text-yellow-400">${escHtml(s.currentOp)}</span>` : '<span class="text-gray-500">idle</span>'}</div>
					</div>
				</div>

				${s.lastError ? `
					<div class="card mb-4" style="border-color: rgba(239,68,68,0.3); background: rgba(239,68,68,0.05);">
						<div class="text-xs text-red-400 mb-1">SON HATA</div>
						<div class="text-sm font-mono break-words">${escHtml(s.lastError)}</div>
					</div>
				` : ''}

				<div class="flex flex-wrap gap-2">
					<button id="gsLoginBtn" class="btn btn-primary" ${s.busy ? 'disabled' : ''}>
						🔑 Login
					</button>
					<button id="gsCheckBtn" class="btn btn-secondary" ${s.busy ? 'disabled' : ''}>
						🔍 Session Kontrol
					</button>
					<button id="gsStopBtn" class="btn btn-danger" ${(!s.browserLaunched || (s.busy && s.currentOp !== 'login')) ? 'disabled' : ''}>
						⏹ Durdur (Browser Kapat)
					</button>
					<button id="gsRefreshBtn" class="btn btn-secondary btn-sm">↻ Yenile</button>
				</div>

				<div class="text-xs text-gray-500 mt-4 mb-6">
					💡 Captcha veya SMS gelirse <strong>🔔 zil</strong> ikonundan müdahale modal'ı açılır.
					Login işlemi 1-3 dakika sürebilir (HITL beklemeleri dahil).
				</div>

				<hr style="border-color:#252530;margin:20px 0;">

				<h3 class="text-lg font-bold mb-3">📦 Sipariş Otomasyonu</h3>
				<div class="grid grid-cols-2 gap-3 mb-4">
					<div class="stat-card">
						<div class="stat-label">Polling</div>
						<div class="text-sm">${s.poll?.enabled ? `<span class="text-green-400">✓ aktif (${s.poll.intervalSec}s)</span>` : '<span class="text-gray-500">durdurulmuş</span>'}</div>
						<div class="stat-sub">Son: ${fmtRel(s.poll?.lastPoll)}</div>
					</div>
					<div class="stat-card">
						<div class="stat-label">Toplam İşlenen</div>
						<div class="text-sm font-bold">${s.orderStats?.totalProcessed || 0}</div>
						<div class="stat-sub">${s.orderStats?.delivered || 0} teslim · ${s.orderStats?.failed || 0} hata</div>
					</div>
				</div>

				<div class="flex flex-wrap gap-2 mb-4">
					<button id="gsPollNowBtn" class="btn btn-primary" ${s.busy ? 'disabled' : ''}>
						▶️ Şimdi Tara (poll-now)
					</button>
					${s.poll?.enabled
						? `<button id="gsPollStopBtn" class="btn btn-danger">⏸ Auto-poll Durdur</button>`
						: `<button id="gsPollStartBtn" class="btn btn-secondary">▶ Auto-poll Başlat</button>`}
					<button id="gsOrdersBtn" class="btn btn-secondary">📋 Son İşlenenler</button>
				</div>

				<div id="gsOrdersList" class="hidden"></div>
			</div>
		`;

		document.getElementById('gsLoginBtn')?.addEventListener('click', async () => {
			try {
				const r = await authFetch('/api/admin/gamesatis/login', { method: 'POST' });
				const data = await r.json();
				if (!r.ok) { toast('Hata: ' + (data.error || r.status), 'error'); return; }
				toast('Login başlatıldı — captcha/SMS gelirse 🔔 modal\'da görürsün', 'info');
				setTimeout(loadStatus, 1000);
			} catch (err) { toast('İstek başarısız: ' + err.message, 'error'); }
		});

		document.getElementById('gsCheckBtn')?.addEventListener('click', async () => {
			try {
				const r = await authFetch('/api/admin/gamesatis/check', { method: 'POST' });
				const data = await r.json();
				if (!r.ok) { toast('Hata: ' + (data.error || r.status), 'error'); return; }
				toast(data.loggedIn ? '✓ Session aktif' : '✗ Session yok', data.loggedIn ? 'success' : 'error');
				loadStatus();
			} catch (err) { toast('Hata: ' + err.message, 'error'); }
		});

		document.getElementById('gsStopBtn')?.addEventListener('click', async () => {
			if (!confirm('Browser\'ı kapatmak istediğinden emin misin? (storage state diske kaydedilir)')) return;
			try {
				const r = await authFetch('/api/admin/gamesatis/stop', { method: 'POST' });
				const data = await r.json();
				if (!r.ok) { toast('Hata: ' + (data.error || r.status), 'error'); return; }
				toast('Durduruldu', 'info');
				loadStatus();
			} catch (err) { toast('Hata: ' + err.message, 'error'); }
		});

		document.getElementById('gsRefreshBtn')?.addEventListener('click', loadStatus);

		document.getElementById('gsPollNowBtn')?.addEventListener('click', async () => {
			const b = document.getElementById('gsPollNowBtn');
			b.disabled = true; b.textContent = '⏳ Tarıyor...';
			try {
				const r = await authFetch('/api/admin/gamesatis/poll-now', { method: 'POST' });
				const data = await r.json();
				if (!r.ok) { toast('Hata: ' + (data.error || r.status), 'error'); return; }
				toast(`✓ ${data.count} sipariş işlendi`, 'success');
				loadStatus();
			} catch (err) { toast('Hata: ' + err.message, 'error'); }
			finally { b.disabled = false; b.textContent = '▶️ Şimdi Tara (poll-now)'; }
		});

		document.getElementById('gsPollStartBtn')?.addEventListener('click', async () => {
			try {
				const r = await authFetch('/api/admin/gamesatis/polling/start', { method: 'POST' });
				const data = await r.json();
				if (!r.ok) { toast('Hata: ' + (data.error || r.status), 'error'); return; }
				toast(`✓ Auto-poll başlatıldı (${data.intervalSec}s aralıkla)`, 'success');
				loadStatus();
			} catch (err) { toast('Hata: ' + err.message, 'error'); }
		});

		document.getElementById('gsPollStopBtn')?.addEventListener('click', async () => {
			try {
				const r = await authFetch('/api/admin/gamesatis/polling/stop', { method: 'POST' });
				if (!r.ok) { toast('Hata', 'error'); return; }
				toast('⏸ Auto-poll durduruldu', 'info');
				loadStatus();
			} catch (err) { toast('Hata: ' + err.message, 'error'); }
		});

		document.getElementById('gsOrdersBtn')?.addEventListener('click', async () => {
			const list = document.getElementById('gsOrdersList');
			if (!list.classList.contains('hidden')) { list.classList.add('hidden'); return; }
			list.classList.remove('hidden');
			list.innerHTML = '<div class="text-center text-gray-500 py-4">Yükleniyor...</div>';
			try {
				const r = await authFetch('/api/admin/gamesatis/orders?limit=20');
				const data = await r.json();
				if (!data.orders?.length) {
					list.innerHTML = '<div class="text-center text-gray-500 py-4">Henüz işlenmiş sipariş yok</div>';
					return;
				}
				list.innerHTML = `
					<div class="text-xs text-gray-500 mb-2">Son ${data.orders.length} işlenmiş sipariş:</div>
					<div style="max-height:300px;overflow-y:auto;">
						${data.orders.map(o => `
							<div class="card mb-2" style="padding:10px;">
								<div class="flex justify-between text-sm">
									<div>
										<strong>#${escHtml(o.orderId)}</strong>
										<span class="text-gray-500"> · ${o.balance || '?'} commend</span>
										${o.delivered ? '<span class="text-green-400 ml-2">✓ teslim</span>' : '<span class="text-yellow-400 ml-2">⚠ kısmi</span>'}
										${o.error ? `<span class="text-red-400 ml-2">✗ ${escHtml(o.error)}</span>` : ''}
									</div>
									<div class="text-xs text-gray-500">${fmtRel(o.processedAt)}</div>
								</div>
								${o.code ? `<div class="text-xs font-mono mt-1" style="color:#a78bfa;">Kod: ${escHtml(o.code)}</div>` : ''}
								${o.buyerSteamUrl ? `<a href="${escHtml(o.buyerSteamUrl)}" target="_blank" class="text-xs text-blue-400">Buyer Steam →</a>` : ''}
							</div>
						`).join('')}
					</div>
				`;
			} catch (err) {
				list.innerHTML = `<div class="text-red-400 text-sm">Hata: ${escHtml(err.message)}</div>`;
			}
		});

		modal.classList.add('active');
		modal.style.opacity = '1';
		modal.style.pointerEvents = 'auto';
		modal.style.display = 'flex';
		modal.style.zIndex = '99999';
		modal.style.position = 'fixed';
		modal.style.inset = '0';
		modal.style.background = 'rgba(0,0,0,0.7)';
		modal.style.alignItems = 'center';
		modal.style.justifyContent = 'center';
	}

	btn.addEventListener('click', async () => {
		await loadStatus();
		renderModal();
	});

	function startPolling() {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = setInterval(loadStatus, 5000);
		loadStatus();
	}

	function init() {
		if (!getToken()) {
			setTimeout(init, 1000);
			return;
		}
		startPolling();
	}
	init();
})();
