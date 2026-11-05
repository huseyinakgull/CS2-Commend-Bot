(function () {
	'use strict';

	let pending = [];
	let sseConn = null;
	let lastNotifiedIds = new Set();

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

	const bell = document.getElementById('hitlBellBtn');
	const badge = document.getElementById('hitlBadge');
	const modal = document.getElementById('modalOverlay');
	const modalContent = document.getElementById('modalContent');

	if (!bell || !badge) {
		console.warn('[hitl-widget] bell/badge bulunamadı', { bell: !!bell, badge: !!badge });
		return;
	}
	console.log('[hitl-widget] v3 init başladı', { hasBell: !!bell, hasBadge: !!badge, hasModal: !!modal, hasModalContent: !!modalContent, hasToken: !!getToken() });

	let notifPermission = false;
	function requestNotificationPermission() {
		if (typeof Notification === 'undefined') return;
		if (Notification.permission === 'granted') { notifPermission = true; return; }
		if (Notification.permission === 'denied') return;
		Notification.requestPermission().then(p => { notifPermission = (p === 'granted'); });
	}

	function notifyBrowser(item) {
		if (notifPermission && typeof Notification !== 'undefined') {
			try {
				new Notification('🚨 Müdahale gerekiyor', {
					body: item.prompt || `${item.source} — ${item.type}`,
					icon: '/logo.jpg',
					tag: 'hitl-' + item.id,
					requireInteraction: true
				});
			} catch {}
		}
		try {
			const ctx = new (window.AudioContext || window.webkitAudioContext)();
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.connect(gain); gain.connect(ctx.destination);
			osc.frequency.value = 880;
			gain.gain.setValueAtTime(0.05, ctx.currentTime);
			gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
			osc.start(); osc.stop(ctx.currentTime + 0.3);
			setTimeout(() => ctx.close(), 500);
		} catch {}
	}

	function updateBadge() {
		if (pending.length === 0) {
			badge.classList.add('hidden');
			document.title = (document.title || '').replace(/^\(\d+\)\s*/, '');
		} else {
			badge.textContent = pending.length;
			badge.classList.remove('hidden');
			const t = (document.title || '').replace(/^\(\d+\)\s*/, '');
			document.title = `(${pending.length}) ${t}`;
		}
	}

	function escHtml(s) {
		return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
	}

	function fmtTime(iso) {
		try { return new Date(iso.replace(' ', 'T') + 'Z').toLocaleTimeString('tr-TR'); }
		catch { return iso || ''; }
	}

	function renderModal() {
		const empty = pending.length === 0
			? '<div class="text-center text-gray-500 py-12">Bekleyen müdahale yok 👌</div>'
			: '';

		const items = pending.map(p => `
			<div class="card mb-3 fade-in" data-hitl-id="${p.id}">
				<div class="flex items-start justify-between mb-2">
					<div>
						<div class="flex items-center gap-2 mb-1">
							<span class="status-pill pill-pending">${escHtml(p.type)}</span>
							<span class="text-xs text-gray-500">${escHtml(p.source)}</span>
							<span class="text-xs text-gray-500">${fmtTime(p.created_at)}</span>
						</div>
						<div class="text-sm">${escHtml(p.prompt || '')}</div>
					</div>
					<button class="btn btn-danger btn-sm" data-action="cancel" data-id="${p.id}">İptal</button>
				</div>
				${p.screenshot_path ? `
					<div style="margin:10px 0 16px;">
						<img src="${escHtml(p.screenshot_path)}?token=${encodeURIComponent(getToken())}" alt="Challenge screenshot"
						     onerror="this.style.display='none'"
						     style="width:100%;max-width:380px;height:auto;display:block;border-radius:8px;border:1px solid #252530;background:#0c0c11;image-rendering:pixelated;">
					</div>` : ''}
				<form data-action="resolve" data-id="${p.id}" class="flex gap-2">
					<input type="text" class="input flex-1" name="answer" placeholder="Cevap (kod / metin)" required autocomplete="off">
					<button class="btn btn-primary" type="submit">Gönder</button>
				</form>
			</div>
		`).join('');

		modalContent.innerHTML = `
			<div class="p-6">
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-xl font-bold">Bekleyen Müdahaleler ${pending.length > 0 ? `<span class="badge-pending">${pending.length}</span>` : ''}</h2>
					<button onclick="window.closeModal&&window.closeModal()" class="text-gray-400 hover:text-white text-2xl">×</button>
				</div>
				${empty}${items}
			</div>
		`;

		modalContent.querySelectorAll('form[data-action="resolve"]').forEach(f => {
			f.addEventListener('submit', onResolveSubmit);
		});
		modalContent.querySelectorAll('button[data-action="cancel"]').forEach(b => {
			b.addEventListener('click', onCancelClick);
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
		console.log('[hitl-widget] modal görünür yapıldı, content height:', modalContent.offsetHeight, 'modal classList:', modal.className);
	}

	if (typeof window.closeModal !== 'function') {
		window.closeModal = function() {
			modal && modal.classList.remove('active');
		};
	}

	async function onResolveSubmit(e) {
		e.preventDefault();
		const id = e.target.dataset.id;
		const answer = e.target.answer.value.trim();
		if (!answer) return;
		const btn = e.target.querySelector('button[type="submit"]');
		btn.disabled = true; btn.textContent = 'Gönderiliyor...';
		try {
			const r = await authFetch(`/api/hitl/admin/resolve/${id}`, {
				method: 'POST',
				body: JSON.stringify({ answer })
			});
			if (!r.ok) {
				const err = await r.json().catch(() => ({}));
				throw new Error(err.error || 'resolve_failed');
			}
			toast('✓ Cevap gönderildi', 'success');
			pending = pending.filter(p => p.id !== Number(id));
			updateBadge();
			renderModal();
		} catch (err) {
			toast('✗ Hata: ' + err.message, 'error');
			btn.disabled = false; btn.textContent = 'Gönder';
		}
	}

	async function onCancelClick(e) {
		const id = e.target.dataset.id;
		if (!confirm('Bu challenge\'ı iptal etmek istediğinden emin misin?')) return;
		try {
			const r = await authFetch(`/api/hitl/admin/cancel/${id}`, { method: 'POST' });
			if (!r.ok) throw new Error('cancel_failed');
			toast('İptal edildi', 'info');
			pending = pending.filter(p => p.id !== Number(id));
			updateBadge();
			renderModal();
		} catch (err) {
			toast('✗ Hata: ' + err.message, 'error');
		}
	}

	function toast(msg, kind = 'info') {
		const c = document.getElementById('toast-container');
		if (!c) { console.log(msg); return; }
		const t = document.createElement('div');
		t.className = `toast toast-${kind} fade-in`;
		t.textContent = msg;
		c.appendChild(t);
		setTimeout(() => t.remove(), 4000);
	}

	async function loadPending() {
		try {
			const r = await authFetch('/api/hitl/admin/pending');
			if (!r.ok) return;
			const data = await r.json();
			pending = data.items || [];
			updateBadge();
		} catch (err) {
			console.warn('[hitl] pending load failed:', err.message);
		}
	}

	function connectSSE() {
		const tok = getToken();
		if (!tok) return;
		setInterval(loadPending, 10000);
	}

	bell.addEventListener('click', async () => {
		console.log('[hitl-widget] bell tıklandı, pending yükleniyor...');
		try {
			await loadPending();
			console.log('[hitl-widget] pending count:', pending.length);
			if (!modal || !modalContent) {
				alert(`HITL widget — modal HTML element eksik. Pending: ${pending.length}\n\n` +
				      pending.map(p => `#${p.id} ${p.type}/${p.source}\nScreenshot: ${location.origin}${p.screenshot_path}?token=${encodeURIComponent(getToken())}`).join('\n\n') +
				      `\n\nGeçici çözüm: /hitl.html sayfasına git`);
				return;
			}
			renderModal();
		} catch (err) {
			console.error('[hitl-widget] bell click hatası:', err);
			alert('HITL hata: ' + err.message);
		}
	});

	function init() {
		if (!getToken()) {
			setTimeout(init, 1000);
			return;
		}
		requestNotificationPermission();
		loadPending();
		const seen = new Set();
		setInterval(async () => {
			await loadPending();
			for (const p of pending) {
				if (!seen.has(p.id)) {
					seen.add(p.id);
					if (lastNotifiedIds.size > 0) {
						notifyBrowser(p);
					}
				}
			}
			lastNotifiedIds = seen;
		}, 8000);
	}

	init();
})();
