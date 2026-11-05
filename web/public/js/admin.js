(() => {
	'use strict';

	console.log('[admin.js] loaded — build v7 · data-action dispatcher aktif');
	const API = '/api/admin';
	const state = {
		token: localStorage.getItem('adminToken') || '',
		section: 'overview',
		sse: null,
		botStatus: null,
		processorStatus: null,
		bots: [],
		maintenance: false,
		txFilters: { status: '', search: '', page: 1, limit: 50 },
		userFilters: { search: '', page: 1, limit: 50 },
		codeFilters: { filter: '', search: '', page: 1, limit: 60 },
		freeFilters: { status: '', page: 1, limit: 50 }
	};

	function $(sel) { return document.querySelector(sel); }
	function $$(sel) { return document.querySelectorAll(sel); }
	function esc(s) {
		if (s === null || s === undefined) return '';
		return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
	}
	function fmtDate(iso) {
		if (!iso) return '—';
		try { return new Date(iso).toLocaleString('tr-TR'); } catch { return iso; }
	}
	function fmtDateShort(iso) {
		if (!iso) return '—';
		try { return new Date(iso).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return iso; }
	}
	function fmtNum(n) { return (Number(n) || 0).toLocaleString('tr-TR'); }
	function fmtBalance(n) { return fmtNum(n) + ' övgü'; }

	function toast(msg, type = 'info') {
		const el = document.createElement('div');
		el.className = `toast toast-${type} fade-in`;
		el.textContent = msg;
		$('#toast-container').appendChild(el);
		setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; }, 3000);
		setTimeout(() => el.remove(), 3500);
	}

	function openModal(html) {
		closeModal();
		const overlay = document.createElement('div');
		overlay.id = 'modalOverlayJS';
		overlay.setAttribute('style',
			'position:fixed;top:0;left:0;width:100vw;height:100vh;' +
			'background:rgba(0,0,0,0.85);z-index:2147483647;' +
			'display:flex;align-items:flex-start;justify-content:center;' +
			'padding:16px;overflow-y:auto;box-sizing:border-box;'
		);
		overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
		const box = document.createElement('div');
		box.id = 'modalContentJS';
		box.setAttribute('style',
			'background:#14141c;border:1px solid #252530;border-radius:16px;' +
			'box-shadow:0 25px 50px -12px rgba(0,0,0,0.8);' +
			'max-width:640px;width:100%;margin:24px auto;color:#fff;' +
			'max-height:calc(100vh - 48px);overflow-y:auto;'
		);
		box.innerHTML = html;
		overlay.appendChild(box);
		document.body.appendChild(overlay);
		document.body.style.overflow = 'hidden';
	}
	function closeModal() {
		const ex = document.getElementById('modalOverlayJS');
		if (ex) ex.remove();
		const old = document.getElementById('modalOverlay');
		if (old) { old.classList.remove('open'); old.style.display = 'none'; }
		const oldC = document.getElementById('modalContent');
		if (oldC) oldC.innerHTML = '';
		document.body.style.overflow = '';
	}
	window.closeModal = closeModal;

	function confirmAction(msg) { return window.confirm(msg); }

	function _readCsrfCookie() {
		const m = document.cookie.match(/(?:^|;\s*)csrf_token=([a-f0-9]{64})/);
		return m ? m[1] : '';
	}

	async function api(path, opts = {}) {
		const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
		if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
		const method = (opts.method || 'GET').toUpperCase();
		if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
			const csrf = _readCsrfCookie();
			if (csrf) headers['X-CSRF-Token'] = csrf;
		}
		const res = await fetch(API + path, { ...opts, credentials: 'same-origin', headers });
		if (res.status === 401) {
			localStorage.removeItem('adminToken');
			state.token = '';
			showLogin();
			throw new Error('Oturum sonlandı');
		}
		const ct = res.headers.get('content-type') || '';
		if (ct.includes('application/json')) {
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || 'İstek başarısız');
			return data;
		}
		const text = await res.text();
		if (!res.ok) throw new Error(text || 'İstek başarısız');
		return text;
	}

	function showLogin() {
		$('#adminLogin').classList.remove('hidden');
		$('#adminPanel').classList.add('hidden');
		if (state.sse) { state.sse.close(); state.sse = null; }
	}
	function showPanel() {
		$('#adminLogin').classList.add('hidden');
		$('#adminPanel').classList.remove('hidden');
		initSSE();
		switchSection(state.section || 'overview');
	}

	async function handleLogin(e) {
		e.preventDefault();
		const pw = $('#adminPassInput').value;
		const btn = $('#adminLoginBtn');
		const errEl = $('#loginError');
		errEl.classList.add('hidden');
		btn.disabled = true;
		btn.textContent = 'Giriş yapılıyor...';
		try {
			const loginRes = await fetch('/api/auth/admin', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ password: pw })
			});
			const loginData = await loginRes.json().catch(() => ({}));
			if (!loginRes.ok) throw new Error(loginData.error || 'Şifre hatalı');
			if (!loginData.token) throw new Error('Token alınamadı');
			state.token = loginData.token;
			localStorage.setItem('adminToken', loginData.token);
			showPanel();
		} catch (err) {
			errEl.textContent = err.message;
			errEl.classList.remove('hidden');
		} finally {
			btn.disabled = false;
			btn.textContent = 'Giriş';
		}
	}

	function logout() {
		localStorage.removeItem('adminToken');
		state.token = '';
		showLogin();
	}

	function initSSE() {
		if (state.sse) state.sse.close();
		if (!state.token) return;
		const url = `${API}/events?token=${encodeURIComponent(state.token)}`;
		try {
			const es = new EventSource(url);
			state.sse = es;
			es.addEventListener('init', (e) => {
				try {
					const d = JSON.parse(e.data);
					if (d.botStatus) { state.botStatus = d.botStatus; updateHeaderBots(); }
					if (d.bots) state.bots = d.bots;
				} catch {}
			});
			es.addEventListener('status', (e) => {
				try {
					const d = JSON.parse(e.data);
					if (d.botStatus) { state.botStatus = d.botStatus; updateHeaderBots(); }
					if (d.processorStatus) state.processorStatus = d.processorStatus;
				} catch {}
			});
			es.addEventListener('botStatusUpdate', (e) => {
				try { state.botStatus = JSON.parse(e.data); updateHeaderBots(); } catch {}
			});
			es.onerror = () => {  };
		} catch {}
	}

	function updateHeaderBots() {
		const s = state.botStatus;
		if (!s) return;
		const total = s.total || 0;
		const ready = s.ready || s.gc_ready || 0;
		$('#headerBotCount').textContent = `Bot: ${ready}/${total}`;
	}

	function switchSection(name) {
		state.section = name;
		$$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.section === name));
		const sec = sections[name];
		if (!sec) return;
		$('#sectionRoot').innerHTML = '<div class="text-gray-500 text-sm">Yükleniyor...</div>';
		Promise.resolve(sec.load()).catch(err => {
			$('#sectionRoot').innerHTML = `<div class="card text-red-400">Hata: ${esc(err.message)}</div>`;
		});
	}

	function paginate(page, totalPages) {
		if (totalPages <= 1) return '';
		const prev = page > 1 ? `<button class="btn btn-secondary btn-sm" data-page="${page - 1}">‹ Önceki</button>` : '';
		const next = page < totalPages ? `<button class="btn btn-secondary btn-sm" data-page="${page + 1}">Sonraki ›</button>` : '';
		return `<div class="flex items-center justify-between mt-4">
			<div class="text-xs text-gray-500">Sayfa ${page} / ${totalPages}</div>
			<div class="flex gap-2">${prev}${next}</div>
		</div>`;
	}

	function bindPagination(container, onChange) {
		container.querySelectorAll('[data-page]').forEach(b => {
			b.addEventListener('click', () => onChange(parseInt(b.dataset.page)));
		});
	}

	function priorityLabel(p) {
		if (p === 2) return 'Acil';
		if (p === 1) return 'Yüksek';
		return 'Normal';
	}

	async function openUserBySteamId(steamId) {
		if (!steamId) return;
		try {
			const r = await api('/users?search=' + encodeURIComponent(steamId) + '&limit=1');
			const u = (r.users || []).find(x => x.steamId === steamId) || (r.users || [])[0];
			if (!u) return toast('Bu Steam ID için kullanıcı bulunamadı', 'info');
			await sections.users.openDrawer(u.id);
		} catch (e) { toast(e.message, 'error'); }
	}

	const actions = {};
	function registerAction(name, fn) { actions[name] = fn; }

	document.addEventListener('click', (e) => {
		const sd = e.target.closest('[data-steam-drill]');
		if (sd) {
			e.stopPropagation();
			openUserBySteamId(sd.dataset.steamDrill);
			return;
		}
		const el = e.target.closest('[data-action]');
		if (!el) return;
		const name = el.dataset.action;
		const fn = actions[name];
		console.log('[action]', name, fn ? 'ok' : 'MISSING');
		if (!fn) { toast('Kayıtsız aksiyon: ' + name, 'error'); return; }
		e.preventDefault();
		try { Promise.resolve(fn(el, e)).catch(err => { console.error('[action-err]', name, err); toast(err.message || 'Hata', 'error'); }); }
		catch (err) { console.error('[action-err]', name, err); toast(err.message || 'Hata', 'error'); }
	});

	registerAction('modal.close', () => closeModal());
	registerAction('codes.generateModal', () => sections.codes.generateModal());
	registerAction('codes.generateSubmit', () => sections.codes.generateSubmit());
	registerAction('codes.viewUser', (el) => sections.users.openDrawer(el.dataset.userId));
	registerAction('codes.deleteOne', (el) => sections.codes.deleteOne(el.dataset.id));
	registerAction('resellers.create', () => sections.resellers.createModal());
	registerAction('resellers.createSubmit', () => sections.resellers.createSubmit());
	registerAction('resellers.edit', (el) => sections.resellers.editModal(parseInt(el.dataset.id)));
	registerAction('resellers.editSubmit', (el) => sections.resellers.editSubmit(parseInt(el.dataset.id)));
	registerAction('resellers.viewCodes', (el) => sections.resellers.viewCodes(parseInt(el.dataset.id)));
	registerAction('resellers.delete', (el) => sections.resellers.deleteOne(parseInt(el.dataset.id), el.dataset.username));
	registerAction('resellers.resetPassword', (el) => sections.resellers.resetPassword(parseInt(el.dataset.id)));
	registerAction('resellers.resetUsage', (el) => sections.resellers.resetUsage(parseInt(el.dataset.id)));
	registerAction('promos.newModal', () => sections.promos.newModal());
	registerAction('promos.createSubmit', () => sections.promos.createSubmit());
	registerAction('promos.toggle', (el) => sections.promos.toggle(el.dataset.id, el.dataset.active === '1'));
	registerAction('promos.delete', (el) => sections.promos.deleteOne(el.dataset.id));
	registerAction('promos.viewRedemptions', (el) => sections.promos.viewRedemptions(el.dataset.id));
	registerAction('server.checkPlayer', () => sections.server.checkPlayer());
	registerAction('server.commendCount', () => sections.server.commendCount());
	registerAction('server.rconExec', () => sections.server.rconExec());
	registerAction('server.rconTest', () => sections.server.rconTest());
	registerAction('server.save', () => sections.server.save());
	registerAction('server.proxyAdd', () => sections.server.proxyAdd());
	registerAction('server.proxySaveSettings', () => sections.server.proxySaveSettings());
	registerAction('server.proxyDelete', (el) => sections.server.proxyDelete(el.dataset.index));

	const sections = {};

	sections.overview = {
		async load() {
			const data = await api('/overview');
			this.render(data);
		},
		render(d) {
			const tx = d.transactions || { byStatus: {} };
			const bs = tx.byStatus || {};
			const users = d.users || {};
			const commends = d.commends || {};
			const balance = d.balance || {};
			const bot = d.botStatus || {};
			const free = d.freeCommends || {};
			const sys = d.system || {};

			const pending = bs.pending || 0;
			const processing = (bs.processing || 0) + (bs.resuming || 0);
			const completed = bs.completed || 0;
			const failed = bs.failed || 0;

			$('#sectionRoot').innerHTML = `
				<div class="mb-5 flex items-center justify-between">
					<h1 class="text-2xl font-bold">Genel Bakış</h1>
					<button id="refreshOverview" class="btn btn-secondary btn-sm">Yenile</button>
				</div>
				<div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
					<div class="stat-card"><div class="stat-label">Bugün İşlem</div><div class="stat-value">${fmtNum(tx.today)}</div><div class="stat-sub">${fmtNum(commends.today)} övgü</div></div>
					<div class="stat-card"><div class="stat-label">Bekleyen</div><div class="stat-value text-yellow-400">${fmtNum(pending)}</div><div class="stat-sub">${fmtNum(processing)} işleniyor</div></div>
					<div class="stat-card"><div class="stat-label">Başarı Oranı</div><div class="stat-value text-green-400">${tx.successRate || 0}%</div><div class="stat-sub">${fmtNum(completed)} ✓ / ${fmtNum(failed)} ✗</div></div>
					<div class="stat-card"><div class="stat-label">Toplam Övgü</div><div class="stat-value">${fmtNum(commends.totalSent)}</div><div class="stat-sub">${fmtNum(commends.verifiedDelivered)} doğrulandı</div></div>
				</div>
				<div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
					<div class="stat-card"><div class="stat-label">Toplam Kullanıcı</div><div class="stat-value">${fmtNum(users.total)}</div><div class="stat-sub">${fmtNum(users.active24h)} aktif · ${fmtNum(users.banned)} yasaklı</div></div>
					<div class="stat-card"><div class="stat-label">Dolaşımda Bakiye</div><div class="stat-value">${fmtBalance(balance.inCirculation)}</div><div class="stat-sub">${fmtBalance(balance.distributed)} dağıtılan</div></div>
					<div class="stat-card"><div class="stat-label">Kodlar</div><div class="stat-value">${fmtNum((d.codes||{}).total)}</div><div class="stat-sub">${fmtNum((d.codes||{}).used)} kullanıldı</div></div>
					<div class="stat-card"><div class="stat-label">Ücretsiz Kuyruk</div><div class="stat-value text-blue-400">${fmtNum(free.pending || 0)}</div><div class="stat-sub">${fmtNum(free.completed || 0)} tamamlandı</div></div>
				</div>
				<div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
					<div class="stat-card"><div class="stat-label">Bot Hazır</div><div class="stat-value text-green-400">${fmtNum(bot.ready || bot.gc_ready || 0)}</div><div class="stat-sub">/ ${fmtNum(bot.total || 0)}</div></div>
					<div class="stat-card"><div class="stat-label">Sunucuda</div><div class="stat-value text-blue-400">${fmtNum(bot.on_server || 0)}</div></div>
					<div class="stat-card"><div class="stat-label">Bağlanıyor</div><div class="stat-value text-yellow-400">${fmtNum((bot.connecting || 0) + (bot.logging_in || 0))}</div></div>
					<div class="stat-card"><div class="stat-label">Hata</div><div class="stat-value text-red-400">${fmtNum(bot.error || 0)}</div></div>
					<div class="stat-card"><div class="stat-label">Meşgul</div><div class="stat-value">${fmtNum(bot.busyCount || 0)}</div></div>
				</div>
				<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
					<div class="card">
						<h3 class="font-semibold mb-3">Durum Dağılımı</h3>
						<div class="space-y-2">${renderStatusBars(bs)}</div>
					</div>
					<div class="card">
						<h3 class="font-semibold mb-3">Son Denetim Olayları</h3>
						<div class="space-y-1 text-xs max-h-80 overflow-y-auto">${renderRecentAudit(d.recentAudit || [])}</div>
					</div>
				</div>
				<div class="card mt-4">
					<h3 class="font-semibold mb-2 text-sm">Sistem</h3>
					<div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-gray-400">
						<div><div class="text-gray-500">Çalışma süresi</div><div class="text-white">${fmtUptime(sys.uptime)}</div></div>
						<div><div class="text-gray-500">Node</div><div class="text-white">${esc(sys.nodeVersion || '—')}</div></div>
						<div><div class="text-gray-500">Platform</div><div class="text-white">${esc(sys.platform || '—')}</div></div>
						<div><div class="text-gray-500">Heap</div><div class="text-white">${fmtBytes((sys.memory||{}).heapUsed)} / ${fmtBytes((sys.memory||{}).heapTotal)}</div></div>
					</div>
				</div>
			`;
			$('#refreshOverview').addEventListener('click', () => this.load());
		}
	};

	function renderStatusBars(byStatus) {
		const order = ['pending', 'processing', 'resuming', 'completed', 'failed', 'cancelled', 'partial'];
		const total = Object.values(byStatus).reduce((a, b) => a + b, 0) || 1;
		return order.map(s => {
			const v = byStatus[s] || 0;
			const pct = (v / total * 100).toFixed(1);
			return `<div>
				<div class="flex justify-between text-xs mb-1"><span class="status-pill pill-${s}">${s}</span><span class="text-gray-400">${fmtNum(v)} (${pct}%)</span></div>
				<div class="bg-[#0c0c11] rounded h-2"><div class="bg-[#c0392b] h-2 rounded" style="width:${pct}%"></div></div>
			</div>`;
		}).join('');
	}
	function renderRecentAudit(list) {
		if (!list.length) return '<div class="text-gray-500">Kayıt yok</div>';
		return list.map(e => `
			<div class="flex gap-2 py-1">
				<span class="text-gray-500 shrink-0">${fmtDateShort(e.timestamp || e.created_at)}</span>
				<span class="text-gray-300 uppercase text-[10px] shrink-0">${esc(e.action || '')}</span>
				<span class="text-gray-500 truncate">${esc(e.actor || '')}</span>
			</div>
		`).join('');
	}
	function fmtUptime(sec) {
		if (!sec) return '—';
		const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
		return h > 0 ? `${h}s ${m}d` : `${m}d`;
	}
	function fmtBytes(b) {
		if (!b) return '—';
		const mb = b / 1024 / 1024;
		return mb > 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(0) + ' MB';
	}

	sections.transactions = {
		async load() {
			const f = state.txFilters;
			const qp = new URLSearchParams();
			if (f.status) qp.set('status', f.status);
			if (f.search) qp.set('search', f.search);
			qp.set('page', f.page); qp.set('limit', f.limit);
			const data = await api('/transactions?' + qp.toString());
			this.render(data);
		},
		render(d) {
			const rows = (d.transactions || []).map(t => {
				const displayName = t.userSteamName || (t.steamId ? 'Bilinmeyen' : '—');
				return `
				<tr class="tx-row-${t.status}">
					<td><input type="checkbox" class="tx-check" data-id="${t.id}"></td>
					<td class="text-gray-400">#${t.id}</td>
					<td><span class="status-pill pill-${t.status}">${t.status}</span></td>
					<td>
						<div class="text-sm">${esc(displayName)}</div>
						${t.steamId ? `<div class="font-mono text-xs text-blue-400 cursor-pointer hover:underline" data-steam-drill="${esc(t.steamId)}">${esc(t.steamId)}</div>` : ''}
					</td>
					<td>${t.progress || 0}/${t.total || 0}</td>
					<td class="text-xs">${priorityLabel(t.priority)}</td>
					<td class="text-gray-500 text-xs whitespace-nowrap">${fmtDateShort(t.createdAt)}</td>
					<td class="text-right whitespace-nowrap">
						<button class="btn btn-secondary btn-sm" data-act="view" data-id="${t.id}">Detay</button>
						${['failed','cancelled'].includes(t.status) ? `<button class="btn btn-secondary btn-sm" data-act="retry" data-id="${t.id}">Tekrar</button>` : ''}
						${['pending','processing','resuming'].includes(t.status) ? `<button class="btn btn-danger btn-sm" data-act="cancel" data-id="${t.id}">İptal</button>` : ''}
					</td>
				</tr>`;
			}).join('');
			const totalPages = d.totalPages || Math.ceil((d.total || 0) / state.txFilters.limit);
			$('#sectionRoot').innerHTML = `
				<div class="mb-5 flex items-center justify-between flex-wrap gap-2">
					<h1 class="text-2xl font-bold">İşlemler <span class="text-sm text-gray-500 font-normal">(${fmtNum(d.total || 0)})</span></h1>
					<div class="flex gap-2">
						<button id="bulkRetry" class="btn btn-secondary btn-sm">Seçilenleri Tekrarla</button>
						<button id="bulkCancel" class="btn btn-danger btn-sm">Seçilenleri İptal</button>
						<button id="exportTxCsv" class="btn btn-secondary btn-sm">CSV Dışa Aktar</button>
					</div>
				</div>
				<div class="card mb-4 flex flex-wrap gap-3 items-end">
					<div class="flex-1 min-w-[180px]">
						<label class="label">Arama</label>
						<input id="txSearch" class="input" placeholder="Steam ID, ad veya kod" value="${esc(state.txFilters.search)}">
					</div>
					<div class="w-40">
						<label class="label">Durum</label>
						<select id="txStatus" class="select">
							<option value="">Hepsi</option>
							<option value="pending">Bekleyen</option>
							<option value="processing">İşleniyor</option>
							<option value="resuming">Devam Ediyor</option>
							<option value="completed">Tamamlandı</option>
							<option value="failed">Başarısız</option>
							<option value="cancelled">İptal</option>
							<option value="partial">Kısmi</option>
						</select>
					</div>
					<button id="txFilterApply" class="btn btn-primary btn-sm">Filtrele</button>
					<button id="txFilterReset" class="btn btn-secondary btn-sm">Sıfırla</button>
				</div>
				<div class="card overflow-x-auto">
					<table class="table">
						<thead><tr>
							<th><input type="checkbox" id="txSelectAll"></th>
							<th>ID</th><th>Durum</th><th>Kullanıcı / Steam ID</th><th>İlerleme</th><th>Öncelik</th><th>Oluşturma</th><th></th>
						</tr></thead>
						<tbody>${rows || '<tr><td colspan="8" class="text-center text-gray-500 py-6">İşlem bulunamadı</td></tr>'}</tbody>
					</table>
					${paginate(state.txFilters.page, totalPages)}
				</div>
			`;
			$('#txStatus').value = state.txFilters.status;
			$('#txFilterApply').addEventListener('click', () => {
				state.txFilters.search = $('#txSearch').value.trim();
				state.txFilters.status = $('#txStatus').value;
				state.txFilters.page = 1;
				this.load();
			});
			$('#txFilterReset').addEventListener('click', () => {
				state.txFilters = { status: '', search: '', page: 1, limit: 50 };
				this.load();
			});
			$('#txSelectAll').addEventListener('change', (e) => {
				$$('.tx-check').forEach(c => c.checked = e.target.checked);
			});
			$('#bulkRetry').addEventListener('click', () => this.bulkAction('retry'));
			$('#bulkCancel').addEventListener('click', () => this.bulkAction('cancel'));
			$('#exportTxCsv').addEventListener('click', () => this.exportCsv());
			$$('#sectionRoot [data-act]').forEach(b => {
				b.addEventListener('click', () => {
					const id = b.dataset.id, act = b.dataset.act;
					if (act === 'view') this.viewDetail(id);
					else if (act === 'retry') this.retry(id);
					else if (act === 'cancel') this.cancel(id);
				});
			});
			bindPagination($('#sectionRoot'), (p) => { state.txFilters.page = p; this.load(); });
		},
		async viewDetail(id) {
			try {
				const d = await api('/transactions/' + id);
				const t = d.transaction || {};
				const curPriority = t.priority === 2 ? 'urgent' : t.priority === 1 ? 'high' : 'normal';
				openModal(`
					<div class="p-6">
						<div class="flex items-center justify-between mb-4">
							<h2 class="text-xl font-bold">İşlem #${t.id}</h2>
							<button onclick="closeModal()" class="text-gray-500 hover:text-white">✕</button>
						</div>
						<div class="grid grid-cols-2 gap-3 text-sm mb-4">
							<div><span class="text-gray-500">Durum:</span> <span class="status-pill pill-${t.status}">${t.status}</span></div>
							<div><span class="text-gray-500">Kullanıcı:</span> ${esc(t.user_steam_name || '—')}</div>
							<div><span class="text-gray-500">Steam ID:</span> <span class="font-mono text-xs">${esc(t.steam_id)}</span></div>
							<div><span class="text-gray-500">Kod:</span> <span class="font-mono text-xs">${esc(t.code || '—')}</span></div>
							<div><span class="text-gray-500">İlerleme:</span> ${t.progress || 0}/${t.total || 0}</div>
							<div><span class="text-gray-500">Öncelik:</span> ${priorityLabel(t.priority)}</div>
							<div><span class="text-gray-500">Dost / Öğretici / Lider:</span> ${t.friendly||0} / ${t.teaching||0} / ${t.leader||0}</div>
							<div><span class="text-gray-500">Deneme:</span> ${t.retry_count || 0}</div>
							<div><span class="text-gray-500">GC Önce:</span> ${t.commends_before ?? '—'}</div>
							<div><span class="text-gray-500">GC Sonra:</span> ${t.commends_after ?? '—'}</div>
							<div><span class="text-gray-500">Doğrulanan:</span> ${t.verified_delivered ?? '—'}</div>
							<div><span class="text-gray-500">Süre:</span> ${t.processing_time_ms ? Math.round(t.processing_time_ms/1000)+'s' : '—'}</div>
							<div><span class="text-gray-500">Oluşturma:</span> ${fmtDate(t.created_at)}</div>
							<div><span class="text-gray-500">Tamamlanma:</span> ${fmtDate(t.completed_at)}</div>
						</div>
						${t.error_message ? `<div class="bg-red-900/20 border border-red-800 rounded p-3 mb-4 text-sm"><div class="text-red-400 text-xs mb-1">HATA (${esc(t.error_type)})</div>${esc(t.error_message)}</div>` : ''}
						${['pending','resuming'].includes(t.status) ? `
						<div class="mb-4">
							<label class="label">Öncelik</label>
							<div class="flex gap-2">
								<select id="modalPriority" class="select flex-1">
									<option value="normal" ${curPriority==='normal'?'selected':''}>Normal</option>
									<option value="high" ${curPriority==='high'?'selected':''}>Yüksek</option>
									<option value="urgent" ${curPriority==='urgent'?'selected':''}>Acil</option>
								</select>
								<button id="modalSetPriority" class="btn btn-primary btn-sm">Kaydet</button>
							</div>
						</div>` : ''}
					</div>
				`);
				const setPr = $('#modalSetPriority');
				if (setPr) setPr.addEventListener('click', async () => {
					const p = $('#modalPriority').value;
					try {
						await api(`/transactions/${t.id}/priority`, { method: 'PATCH', body: JSON.stringify({ priority: p }) });
						toast('Öncelik güncellendi', 'success');
						closeModal();
						this.load();
					} catch (e) { toast(e.message, 'error'); }
				});
			} catch (e) { toast(e.message, 'error'); }
		},
		async retry(id) {
			if (!confirmAction('İşlemi tekrar kuyruğa almak istediğinize emin misiniz? Kalan miktar kadar bakiye yeniden düşülecek.')) return;
			try {
				await api(`/transactions/${id}/retry`, { method: 'POST' });
				toast('İşlem yeniden kuyruğa alındı', 'success');
				this.load();
			} catch (e) { toast(e.message, 'error'); }
		},
		async cancel(id) {
			if (!confirmAction('İşlemi iptal et ve kalan tutarı iade et?')) return;
			try {
				const r = await api(`/transactions/${id}/cancel`, { method: 'POST' });
				toast('İptal edildi' + (r.refunded ? ` · ${fmtBalance(r.refunded)} iade` : ''), 'success');
				this.load();
			} catch (e) { toast(e.message, 'error'); }
		},
		async bulkAction(kind) {
			const ids = Array.from($$('.tx-check')).filter(c => c.checked).map(c => parseInt(c.dataset.id));
			if (!ids.length) return toast('Seçim yok', 'info');
			if (!confirmAction(`${ids.length} işlem için "${kind}" uygulansın mı?`)) return;
			try {
				const r = await api(`/transactions/bulk-${kind}`, { method: 'POST', body: JSON.stringify({ ids }) });
				const n = r.retried ?? r.cancelled ?? 0;
				toast(`İşlendi: ${n}${r.refunded ? ` · ${fmtBalance(r.refunded)} iade` : ''}`, 'success');
				this.load();
			} catch (e) { toast(e.message, 'error'); }
		},
		async exportCsv() {
			try {
				const res = await fetch(API + '/transactions/export/csv', {
					headers: { 'Authorization': 'Bearer ' + state.token }
				});
				if (!res.ok) throw new Error('Dışa aktarım başarısız');
				const text = await res.text();
				const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = `transactions-${Date.now()}.csv`;
				a.click();
				URL.revokeObjectURL(url);
			} catch (e) { toast(e.message, 'error'); }
		}
	};

	sections.manualOrder = {
		async load() {
			$('#sectionRoot').innerHTML = `
				<div class="max-w-2xl">
					<h2 class="text-xl font-bold mb-1">📦 Manuel Sipariş</h2>
					<p class="text-sm text-gray-400 mb-5">Otomasyonu olmayan satıcılardan (FunPay, ItemSatis vb.) sipariş aldığında: Steam profil + miktar gir, "Başlat" — sistem TX'i oluşturur ve commend göndermeye başlar.</p>

					<form id="manualOrderForm" class="card flex flex-col gap-4">
						<div>
							<label class="block text-sm font-medium mb-1">Steam Profil URL veya Steam ID</label>
							<input type="text" id="moSteam" class="input w-full" placeholder="76561198... veya steamcommunity.com/profiles/... veya /id/vanity-name" required autocomplete="off" autofocus>
							<p class="text-xs text-gray-500 mt-1">Vanity URL (ör. /id/kullanici-adi) otomatik çözülür.</p>
						</div>

						<div>
							<label class="block text-sm font-medium mb-1">Toplam Commend</label>
							<input type="number" id="moTotal" class="input w-full" min="1" max="5000" value="100" required>
							<p class="text-xs text-gray-500 mt-1">Friendly + Teaching + Leader hepsi bu sayıya eşit gönderilir (örn. 100 = 100/100/100).</p>
						</div>

						<div>
							<label class="block text-sm font-medium mb-1">Kaynak (opsiyonel)</label>
							<select id="moSource" class="input w-full">
								<option value="">— seçilmedi —</option>
								<option value="funpay">FunPay</option>
								<option value="itemsatis">ItemSatış</option>
								<option value="g2g">G2G</option>
								<option value="ggsel">GGSel</option>
								<option value="kinguin">Kinguin</option>
								<option value="discord_dm">Discord DM</option>
								<option value="other">Diğer</option>
							</select>
						</div>

						<div>
							<label class="block text-sm font-medium mb-1">Not (opsiyonel)</label>
							<input type="text" id="moNote" class="input w-full" placeholder="Sipariş ID, müşteri adı, özel not..." maxlength="200">
						</div>

						<div class="flex items-center gap-3">
							<button type="submit" id="moSubmit" class="btn btn-primary">📦 İşlemi Başlat</button>
							<button type="reset" class="btn btn-secondary">Temizle</button>
							<div id="moStatus" class="text-sm"></div>
						</div>
					</form>

					<div id="moResult" class="hidden mt-5"></div>
				</div>
			`;

			const form = $('#manualOrderForm');
			form.addEventListener('submit', async (ev) => {
				ev.preventDefault();
				const submitBtn = $('#moSubmit');
				const status = $('#moStatus');
				const result = $('#moResult');

				const steamInput = $('#moSteam').value.trim();
				const total = parseInt($('#moTotal').value, 10);
				const source = $('#moSource').value || null;
				const note = $('#moNote').value.trim() || null;

				if (!steamInput) return toast('Steam ID/URL gerekli', 'error');
				if (!Number.isFinite(total) || total < 1 || total > 5000) {
					return toast('Toplam 1-5000 arası bir sayı olmalı', 'error');
				}

				submitBtn.disabled = true;
				status.textContent = 'Steam ID çözümleniyor + TX oluşturuluyor...';
				status.className = 'text-sm text-gray-400';
				result.classList.add('hidden');

				try {
					const res = await api('/manual-order', {
						method: 'POST',
						body: JSON.stringify({
							steamId: steamInput,
							total,
							source,
							note
						})
					});

					status.textContent = `✓ TX #${res.transactionId} oluşturuldu`;
					status.className = 'text-sm text-green-400';

					result.className = 'card mt-5 border-green-700 bg-green-950/30';
					result.innerHTML = `
						<div class="flex items-start gap-3">
							<div class="text-2xl">✅</div>
							<div class="flex-1">
								<div class="font-semibold text-green-400 mb-1">İşlem başlatıldı</div>
								<div class="text-sm text-gray-300 space-y-1">
									<div><span class="text-gray-500">TX ID:</span> <span class="font-mono">#${res.transactionId}</span></div>
									<div><span class="text-gray-500">Steam ID:</span> <span class="font-mono">${esc(res.steamId)}</span></div>
									<div><span class="text-gray-500">Hedef:</span> ${res.total} commend (${res.friendly} friendly / ${res.teaching} teaching / ${res.leader} leader)</div>
									${source ? `<div><span class="text-gray-500">Kaynak:</span> ${esc(source)}</div>` : ''}
									${note ? `<div><span class="text-gray-500">Not:</span> ${esc(note)}</div>` : ''}
								</div>
								<div class="mt-3 text-xs text-gray-400">Processor TX'i 5sn içinde alır. İlerlemeyi <button class="text-blue-400 underline" data-act="manualOrder.goTransactions">İşlemler sekmesinden</button> takip edebilirsin.</div>
							</div>
						</div>
					`;
					result.classList.remove('hidden');

					form.reset();
					$('#moSteam').focus();
					toast(`TX #${res.transactionId} oluşturuldu`, 'success');
				} catch (err) {
					status.textContent = '';
					toast('Hata: ' + (err.message || 'bilinmeyen'), 'error');
				} finally {
					submitBtn.disabled = false;
				}
			});
		}
	};
	registerAction('manualOrder.goTransactions', () => switchSection('transactions'));

	sections.hesap = {
		_pollTimer: null,
		async load() {
			$('#sectionRoot').innerHTML = `
				<div class="max-w-3xl">
					<h2 class="text-xl font-bold mb-1">🛒 hesap.com.tr Otomasyonu</h2>
					<p class="text-sm text-gray-400 mb-5">Cloudflare arkasında çalışan satıcı paneli. Proxy + browser UA + Google OAuth ile session yönetilir. <strong>İlk login manuel</strong> — VDS'e RDP ile bağlanıp açılan Chrome'da Google ile giriş yapman gerekir; sonraki restart'lar otomatik.</p>

					<div class="card mb-4">
						<h3 class="text-base font-semibold mb-3">Durum</h3>
						<div id="hesapStatus" class="text-sm text-gray-400">Yükleniyor...</div>
					</div>

					<div class="card mb-4">
						<h3 class="text-base font-semibold mb-3">Aksiyonlar</h3>
						<div class="flex flex-wrap gap-2">
							<button class="btn btn-primary" data-act="hesap.login">🔐 İlk Login (Manuel)</button>
							<button class="btn btn-secondary" data-act="hesap.check">🔍 Session Kontrol</button>
							<button class="btn btn-secondary" data-act="hesap.pollNow">📥 Şimdi Tara (Sipariş)</button>
							<button class="btn btn-secondary" data-act="hesap.startPolling">▶️ Polling Başlat</button>
							<button class="btn btn-secondary" data-act="hesap.stopPolling">⏸ Polling Durdur</button>
							<button class="btn btn-secondary" data-act="hesap.reactivate">♻️ Pasif İlanları Yayına Al</button>
							<button class="btn btn-danger" data-act="hesap.stop">⏹ Browser Kapat</button>
						</div>
						<div id="hesapResult" class="mt-3 text-sm"></div>
					</div>

					<div class="card mb-4">
						<h3 class="text-base font-semibold mb-2">İşlenen Siparişler</h3>
						<div id="hesapOrders" class="text-sm text-gray-400">Yükleniyor...</div>
					</div>

					<div class="card border-yellow-700/50 bg-yellow-950/20 text-sm text-yellow-200">
						<div class="font-semibold mb-2">⚠️ DOM Selector'lar Henüz Eksik</div>
						<p class="text-yellow-300/80">Sipariş işleme/reactivate fonksiyonları <strong>dry-run</strong> modunda çalışıyor. Selector'ları gerçek sayfaya göre düzeltmem için bana ekran görüntüsü ver:</p>
						<ul class="list-disc ml-6 mt-2 text-yellow-300/80 text-xs">
							<li><code class="bg-black/40 px-1 rounded">/p/sattigim-ilanlar</code> — bekleyen sipariş kart yapısı</li>
							<li><code class="bg-black/40 px-1 rounded">/p/pasifilanlarim</code> — yeniden yayına alma butonu</li>
							<li>Mesaj drawer açıldığındaki görünümü</li>
							<li>Bizim CS2 ürün URL pattern (cs2-ovgu/cs2-commend?)</li>
						</ul>
					</div>
				</div>
			`;
			await this.refreshStatus();
			await this.refreshOrders();
		},

		async refreshStatus() {
			try {
				const s = await api('/hesap/status');
				const stateColor = s.state === 'ready' ? 'text-green-400'
					: s.state === 'error' ? 'text-red-400'
					: s.state === 'working' || s.state === 'launching' ? 'text-yellow-400'
					: 'text-gray-400';
				const sessionLabel = s.sessionAlive === true ? '<span class="text-green-400">Aktif ✓</span>'
					: s.sessionAlive === false ? '<span class="text-red-400">Süresi dolmuş ✗</span>'
					: '<span class="text-gray-500">Bilinmiyor</span>';
				$('#hesapStatus').innerHTML = `
					<div class="grid grid-cols-2 gap-x-6 gap-y-1">
						<div><span class="text-gray-500">State:</span> <span class="${stateColor} font-semibold">${esc(s.state)}</span></div>
						<div><span class="text-gray-500">Session:</span> ${sessionLabel}</div>
						<div><span class="text-gray-500">Browser:</span> ${s.browserLaunched ? '<span class="text-green-400">Açık</span>' : '<span class="text-gray-500">Kapalı</span>'}</div>
						<div><span class="text-gray-500">Busy:</span> ${s.busy ? `<span class="text-yellow-400">Evet (${esc(s.currentOp || '?')})</span>` : '<span class="text-gray-400">Hayır</span>'}</div>
						<div><span class="text-gray-500">Polling:</span> ${s.poll?.enabled ? `<span class="text-green-400">Aktif (${s.poll.intervalSec}s)</span>` : '<span class="text-gray-500">Pasif</span>'}</div>
						<div><span class="text-gray-500">Proxy:</span> <span class="font-mono text-xs">${esc(s.proxy || 'YOK ⚠')}</span></div>
						<div class="col-span-2 mt-1"><span class="text-gray-500">Son aksiyon:</span> ${esc(s.lastAction || '—')} <span class="text-gray-600">(${s.lastActionAt ? new Date(s.lastActionAt).toLocaleString('tr-TR') : '—'})</span></div>
						${s.lastError ? `<div class="col-span-2"><span class="text-gray-500">Son hata:</span> <span class="text-red-400">${esc(s.lastError)}</span></div>` : ''}
						${s.poll?.lastPoll ? `<div class="col-span-2"><span class="text-gray-500">Son poll:</span> ${new Date(s.poll.lastPoll).toLocaleString('tr-TR')}</div>` : ''}
					</div>
				`;
			} catch (err) {
				$('#hesapStatus').innerHTML = `<span class="text-red-400">Status hatası: ${esc(err.message)}</span>`;
			}
		},

		async refreshOrders() {
			try {
				const data = await api('/hesap/orders?limit=20');
				const orders = data.orders || [];
				if (orders.length === 0) {
					$('#hesapOrders').innerHTML = '<span class="text-gray-500">Henüz işlenmiş sipariş yok</span>';
					return;
				}
				$('#hesapOrders').innerHTML = `
					<div class="text-xs text-gray-500 mb-2">Toplam: ${data.stats?.total || 0} · Son poll: ${data.stats?.lastPoll ? new Date(data.stats.lastPoll).toLocaleString('tr-TR') : '—'}</div>
					<table class="w-full text-xs">
						<thead><tr class="text-gray-500 border-b border-[#252530]"><th class="text-left py-1">Order ID</th><th class="text-left py-1">Tarih</th><th class="text-left py-1">Detay</th></tr></thead>
						<tbody>
							${orders.map(o => `<tr class="border-b border-[#1a1a22]"><td class="py-1 font-mono">#${esc(o.orderId)}</td><td class="py-1 text-gray-400">${o.at ? new Date(o.at).toLocaleString('tr-TR') : '—'}</td><td class="py-1 text-gray-400">${esc(JSON.stringify(o).substring(0, 100))}</td></tr>`).join('')}
						</tbody>
					</table>
				`;
			} catch (err) {
				$('#hesapOrders').innerHTML = `<span class="text-red-400">Sipariş listesi hatası: ${esc(err.message)}</span>`;
			}
		},

		async _act(name, fn) {
			const result = $('#hesapResult');
			result.innerHTML = `<span class="text-gray-400">⏳ ${name}...</span>`;
			try {
				const r = await fn();
				result.innerHTML = `<span class="text-green-400">✓ ${name}:</span> <span class="text-gray-300">${esc(JSON.stringify(r).substring(0, 300))}</span>`;
				toast(`${name} OK`, 'success');
			} catch (err) {
				result.innerHTML = `<span class="text-red-400">✗ ${name} hatası:</span> <span class="text-gray-300">${esc(err.message)}</span>`;
				toast(`${name} hatası: ${err.message}`, 'error');
			}
			await this.refreshStatus();
			await this.refreshOrders();
		}
	};
	registerAction('hesap.login', () => sections.hesap._act('Login', () => api('/hesap/login', { method: 'POST' })));
	registerAction('hesap.check', () => sections.hesap._act('Check', () => api('/hesap/check', { method: 'POST' })));
	registerAction('hesap.pollNow', () => sections.hesap._act('Poll', () => api('/hesap/poll-now', { method: 'POST' })));
	registerAction('hesap.startPolling', () => sections.hesap._act('Polling Başlat', () => api('/hesap/polling/start', { method: 'POST' })));
	registerAction('hesap.stopPolling', () => sections.hesap._act('Polling Durdur', () => api('/hesap/polling/stop', { method: 'POST' })));
	registerAction('hesap.reactivate', () => sections.hesap._act('Reactivate', () => api('/hesap/reactivate-listings', { method: 'POST' })));
	registerAction('hesap.stop', () => sections.hesap._act('Stop', () => api('/hesap/stop', { method: 'POST' })));

	sections.freeCommends = {
		async load() {
			const f = state.freeFilters;
			const qp = new URLSearchParams();
			if (f.status) qp.set('status', f.status);
			qp.set('page', f.page); qp.set('limit', f.limit);
			const data = await api('/free-commends?' + qp.toString());
			this.render(data);
		},
		render(d) {
			const list = d.freeCommends || [];
			const rows = list.map(i => `
				<tr>
					<td>#${i.id}</td>
					<td class="font-mono text-xs">${esc(i.steamId || '')}</td>
					<td><span class="status-pill pill-${i.status || 'pending'}">${i.status || '—'}</span></td>
					<td>${i.progress || 0}/${i.total || 0}</td>
					<td class="text-xs">${i.txStatus ? `<span class="status-pill pill-${i.txStatus}">${i.txStatus}</span>` : '—'}${i.txProgress != null ? ` <span class="text-gray-500">(${i.txProgress})</span>` : ''}</td>
					<td class="font-mono text-xs">${esc(i.ip || '—')}</td>
					<td class="text-gray-500 text-xs">${fmtDateShort(i.createdAt)}</td>
					<td class="text-right">
						<button class="btn btn-danger btn-sm" data-del="${i.id}">Sil/İptal</button>
					</td>
				</tr>
			`).join('');
			const totalPages = d.totalPages || Math.ceil((d.total || 0) / state.freeFilters.limit);
			$('#sectionRoot').innerHTML = `
				<div class="mb-5 flex items-center justify-between">
					<h1 class="text-2xl font-bold">Ücretsiz Övgüler <span class="text-sm text-gray-500 font-normal">(${fmtNum(d.total || 0)})</span></h1>
					<select id="freeFilter" class="select w-48">
						<option value="">Tümü</option>
						<option value="pending">Bekleyen</option>
						<option value="completed">Tamamlanan</option>
						<option value="cancelled">İptal</option>
						<option value="failed">Başarısız</option>
					</select>
				</div>
				<div class="card overflow-x-auto">
					<table class="table">
						<thead><tr><th>ID</th><th>Steam ID</th><th>Durum</th><th>İlerleme</th><th>İşlem</th><th>IP</th><th>Tarih</th><th></th></tr></thead>
						<tbody>${rows || '<tr><td colspan="8" class="text-center text-gray-500 py-6">Kayıt yok</td></tr>'}</tbody>
					</table>
					${paginate(state.freeFilters.page, totalPages)}
				</div>
			`;
			$('#freeFilter').value = state.freeFilters.status;
			$('#freeFilter').addEventListener('change', (e) => {
				state.freeFilters.status = e.target.value;
				state.freeFilters.page = 1;
				this.load();
			});
			$$('#sectionRoot [data-del]').forEach(b => {
				b.addEventListener('click', async () => {
					if (!confirmAction('Bu ücretsiz övgü kaydını sil/iptal et?')) return;
					try {
						await api('/free-commends/' + b.dataset.del, { method: 'DELETE' });
						toast('İşlendi', 'success');
						this.load();
					} catch (e) { toast(e.message, 'error'); }
				});
			});
			bindPagination($('#sectionRoot'), (p) => { state.freeFilters.page = p; this.load(); });
		}
	};

	sections.bots = {
		async load() {
			const data = await api('/bots');
			this.render(data);
		},
		render(d) {
			state.bots = d.bots || [];
			const status = d.status || {};
			const now = Date.now();
			const bots = [...state.bots].sort((a, b) => {
				const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
				const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
				return tb - ta;
			});

			const rows = bots.map(b => {
				const st = b.status || 'idle';
				const busy = !['disconnected', 'offline', 'idle', 'logged_out'].includes(st);
				const profileUrl = b.steamId && /^\d{17}$/.test(b.steamId) ? `https://steamcommunity.com/profiles/${b.steamId}` : null;
				return `
				<tr>
					<td>
						<div class="font-semibold">${esc(b.username)}</div>
						<div class="text-xs text-gray-500 font-mono">${esc(b.steamId || '—')}${profileUrl ? ` · <a href="${profileUrl}" target="_blank" rel="noopener" class="text-blue-400 hover:underline">Steam ↗</a>` : ''}</div>
					</td>
					<td>
						${busy
							? `<span class="status-pill pill-${st}">${st}</span>${b.currentTarget ? `<div class="text-xs text-blue-400 mt-1">→ ${esc(b.currentTarget)}</div>` : ''}`
							: `<span class="text-xs text-gray-500">${st === 'error' ? '<span class="text-red-400">hata</span>' : 'boşta'}</span>`}
					</td>
					<td>${fmtNum(b.commendsSent || 0)}</td>
					<td class="text-xs text-gray-500">${b.lastActivity ? fmtDateShort(b.lastActivity) : '—'}</td>
					<td class="text-xs text-red-400 max-w-[220px] truncate" title="${esc(b.lastError || '')}">${esc(b.lastError || '')}</td>
					<td class="text-right whitespace-nowrap">
						${busy ? `<button class="btn btn-secondary btn-sm" data-bot="${esc(b.username)}" data-act="stop">Durdur</button>` : ''}
						<button class="btn btn-secondary btn-sm" data-bot="${esc(b.username)}" data-act="reconnect">Test Giriş</button>
						<button class="btn btn-danger btn-sm" data-bot="${esc(b.username)}" data-act="purge">Sil</button>
					</td>
				</tr>`;
			}).join('');

			$('#sectionRoot').innerHTML = `
				<div class="mb-3 flex items-center justify-between flex-wrap gap-2">
					<div>
						<h1 class="text-2xl font-bold">Hesap Havuzu <span class="text-sm text-gray-500 font-normal">(${state.bots.length})</span></h1>
						<p class="text-xs text-gray-500 mt-1">Hesaplar yalnızca bir işlem geldiğinde giriş yapıp işi bitince çıkar. "boşta" normaldir.</p>
					</div>
					<div class="flex gap-2 flex-wrap">
						<button id="botAddNew" class="btn btn-primary btn-sm">+ Hesap Ekle</button>
						<button id="botHealthCheck" class="btn btn-secondary btn-sm">Sağlık Kontrolü</button>
						<button id="botStopAll" class="btn btn-secondary btn-sm">Aktifleri Durdur</button>
						<button id="botViewInvalid" class="btn btn-danger btn-sm">Geçersiz Hesaplar</button>
					</div>
				</div>
				<div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
					<div class="stat-card"><div class="stat-label">Toplam Hesap</div><div class="stat-value">${status.total || state.bots.length}</div></div>
					<div class="stat-card"><div class="stat-label">Şu An Meşgul</div><div class="stat-value text-blue-400">${status.busyCount || (status.on_server || 0) + (status.ready || 0)}</div></div>
					<div class="stat-card"><div class="stat-label">Bağlanıyor</div><div class="stat-value text-yellow-400">${(status.connecting || 0) + (status.logging_in || 0)}</div></div>
					<div class="stat-card"><div class="stat-label">Hatalı</div><div class="stat-value text-red-400">${status.error || 0}</div></div>
					<div class="stat-card"><div class="stat-label">Toplam Övgü</div><div class="stat-value">${fmtNum(bots.reduce((a, b) => a + (b.commendsSent || 0), 0))}</div></div>
				</div>
				<div class="card overflow-x-auto">
					<table class="table">
						<thead><tr><th>Hesap</th><th>Anlık Durum</th><th>Gönderilen</th><th>Son Aktivite</th><th>Son Hata</th><th></th></tr></thead>
						<tbody>${rows || '<tr><td colspan="6" class="text-center text-gray-500 py-8">Hesap yok</td></tr>'}</tbody>
					</table>
				</div>
			`;
			$('#botAddNew').addEventListener('click', () => this.addAccountModal());
			$('#botStopAll').addEventListener('click', () => this.bulk('stop'));
			$('#botHealthCheck').addEventListener('click', () => this.bulk('health-check'));
			$('#botViewInvalid').addEventListener('click', () => this.viewInvalid());
			$$('#sectionRoot [data-bot]').forEach(btn => {
				btn.addEventListener('click', async () => {
					const u = btn.dataset.bot, act = btn.dataset.act;
					try {
						if (act === 'purge') {
							if (!confirmAction(`${u} hesabını kalıcı olarak sil?`)) return;
							await api('/bots/' + encodeURIComponent(u), { method: 'DELETE' });
							toast('Silindi', 'success');
						} else {
							await api(`/bots/${encodeURIComponent(u)}/${act}`, { method: 'POST' });
							toast(`${act} gönderildi`, 'success');
						}
						setTimeout(() => this.load(), 500);
					} catch (e) { toast(e.message, 'error'); }
				});
			});
		},
		async bulk(action) {
			if ((action === 'stop' || action === 'reconnect') && !confirmAction('Toplu işlemi onaylıyor musunuz?')) return;
			try {
				await api('/bots/bulk/' + action, { method: 'POST' });
				toast(`Toplu ${action} gönderildi`, 'success');
				setTimeout(() => this.load(), 800);
			} catch (e) { toast(e.message, 'error'); }
		},
		addAccountModal() {
			openModal(`
				<div class="p-6">
					<h2 class="text-xl font-bold mb-4">Yeni Bot Hesabı</h2>
					<div class="mb-3"><label class="label">Kullanıcı Adı</label><input id="accUser" class="input"></div>
					<div class="mb-3"><label class="label">Şifre</label><input id="accPass" type="password" class="input"></div>
					<div class="mb-4"><label class="label">Shared Secret (2FA)</label><input id="accSecret" class="input"></div>
					<div class="flex justify-end gap-2">
						<button onclick="closeModal()" class="btn btn-secondary btn-sm">İptal</button>
						<button id="accAddBtn" class="btn btn-primary btn-sm">Ekle</button>
					</div>
				</div>
			`);
			$('#accAddBtn').addEventListener('click', async () => {
				const username = $('#accUser').value.trim();
				const password = $('#accPass').value;
				const sharedSecret = $('#accSecret').value.trim();
				if (!username || !password) return toast('Kullanıcı adı ve şifre gerekli', 'error');
				try {
					await api('/bots', { method: 'POST', body: JSON.stringify({ username, password, sharedSecret }) });
					toast('Hesap eklendi', 'success');
					closeModal();
					this.load();
				} catch (e) { toast(e.message, 'error'); }
			});
		},
		async viewInvalid() {
			try {
				const d = await api('/bots/invalid');
				const list = (d.invalid || []).map(i => `<tr><td>${esc(i.username)}</td><td class="text-red-400 text-xs">${esc(i.reason || '')}</td><td class="text-xs text-gray-500">${fmtDateShort(i.timestamp || i.ts)}</td></tr>`).join('');
				openModal(`
					<div class="p-6">
						<div class="flex items-center justify-between mb-4">
							<h2 class="text-xl font-bold">Geçersiz Hesaplar</h2>
							<button onclick="closeModal()" class="text-gray-500 hover:text-white">✕</button>
						</div>
						<table class="table"><thead><tr><th>Kullanıcı</th><th>Sebep</th><th>Zaman</th></tr></thead><tbody>${list || '<tr><td colspan="3" class="text-center text-gray-500 py-4">Yok</td></tr>'}</tbody></table>
					</div>
				`);
			} catch (e) { toast(e.message, 'error'); }
		}
	};

	sections.users = {
		async load() {
			const f = state.userFilters;
			const qp = new URLSearchParams();
			if (f.search) qp.set('search', f.search);
			qp.set('page', f.page); qp.set('limit', f.limit);
			const data = await api('/users?' + qp.toString());
			this.render(data);
		},
		render(d) {
			const rows = (d.users || []).map(u => {
				const profileUrl = u.steamId && /^\d{17}$/.test(u.steamId) ? `https://steamcommunity.com/profiles/${u.steamId}` : null;
				return `
				<tr class="cursor-pointer" data-uid="${u.id}">
					<td>#${u.id}</td>
					<td>
						<div>${esc(u.steamName || '—')}</div>
						<div class="text-xs text-gray-500 font-mono">${esc(u.steamId || '—')}${profileUrl ? ` · <a href="${profileUrl}" target="_blank" rel="noopener" class="text-blue-400 hover:underline" onclick="event.stopPropagation()">Steam ↗</a>` : ''}</div>
					</td>
					<td class="font-mono text-xs">${esc(u.code || '—')}</td>
					<td>${fmtBalance(u.balance)}</td>
					<td>${u.txCount || 0}</td>
					<td>${u.totalCommends || 0}</td>
					<td>${u.banned ? '<span class="status-pill pill-failed">Yasaklı</span>' : '<span class="status-pill pill-online">Aktif</span>'}</td>
					<td class="text-gray-500 text-xs whitespace-nowrap">${fmtDateShort(u.createdAt)}</td>
				</tr>`;
			}).join('');
			const totalPages = d.totalPages || Math.ceil((d.total || 0) / state.userFilters.limit);
			$('#sectionRoot').innerHTML = `
				<div class="mb-5 flex items-center justify-between">
					<h1 class="text-2xl font-bold">Kullanıcılar <span class="text-sm text-gray-500 font-normal">(${fmtNum(d.total || 0)})</span></h1>
					<input id="userSearch" class="input w-64" placeholder="Steam adı, ID veya kod" value="${esc(state.userFilters.search)}">
				</div>
				<div class="card overflow-x-auto">
					<table class="table">
						<thead><tr><th>ID</th><th>Kullanıcı</th><th>Kod</th><th>Bakiye</th><th>İşlem</th><th>Övgü</th><th>Durum</th><th>Kayıt</th></tr></thead>
						<tbody>${rows || '<tr><td colspan="8" class="text-center text-gray-500 py-6">Kullanıcı yok</td></tr>'}</tbody>
					</table>
					${paginate(state.userFilters.page, totalPages)}
				</div>
			`;
			let deb;
			$('#userSearch').addEventListener('input', (e) => {
				clearTimeout(deb);
				deb = setTimeout(() => {
					state.userFilters.search = e.target.value.trim();
					state.userFilters.page = 1;
					this.load();
				}, 300);
			});
			$$('#sectionRoot tr[data-uid]').forEach(r => {
				r.addEventListener('click', () => this.openDrawer(r.dataset.uid));
			});
			bindPagination($('#sectionRoot'), (p) => { state.userFilters.page = p; this.load(); });
		},
		async openDrawer(id) {
			try {
				const d = await api('/users/' + id);
				const u = d.user || {};
				const txList = d.transactions || [];
				const profileUrl = u.steam_id && /^\d{17}$/.test(u.steam_id) ? `https://steamcommunity.com/profiles/${u.steam_id}` : null;
				const byStatus = txList.reduce((a, t) => { a[t.status] = (a[t.status]||0) + 1; return a; }, {});
				const totalCommends = txList.reduce((a, t) => a + (t.progress || 0), 0);
				const sessions = (d.sessions || []).map(s => `
					<div class="flex items-center justify-between py-1.5 border-b border-[#1a1a24] text-xs">
						<div><span class="text-gray-400 font-mono">${esc(s.ip || '—')}</span> <span class="text-gray-500 ml-2">${fmtDateShort(s.created_at)}</span> ${s.is_active ? '<span class="text-green-400 ml-2">aktif</span>' : '<span class="text-gray-500 ml-2">pasif</span>'}</div>
						${s.is_active ? `<button class="btn btn-danger btn-sm" data-kick="${s.id}">Sonlandır</button>` : ''}
					</div>
				`).join('') || '<div class="text-gray-500 text-xs">Oturum yok</div>';
				const txs = txList.slice(0, 30).map(t => `
					<div class="flex justify-between items-center py-1 text-xs border-b border-[#1a1a24] cursor-pointer hover:bg-[#1a1a24] px-1 rounded" data-tx-view="${t.id}">
						<span>#${t.id} <span class="status-pill pill-${t.status}">${t.status}</span></span>
						<span class="text-gray-500">${t.progress}/${t.total} · ${fmtDateShort(t.created_at)}</span>
					</div>
				`).join('') || '<div class="text-gray-500 text-xs">İşlem yok</div>';
				const userAudit = (d.audit || []).slice(0, 10).map(a => `
					<div class="py-1 text-xs border-b border-[#1a1a24]">
						<span class="text-gray-500">${fmtDateShort(a.created_at)}</span> · <span class="uppercase text-gray-300">${esc(a.action)}</span> · <span class="text-gray-500">${esc(a.actor || '')}</span>
					</div>
				`).join('') || '<div class="text-gray-500 text-xs">Denetim kaydı yok</div>';
				openModal(`
					<div class="p-6">
						<div class="flex items-center justify-between mb-4">
							<div>
								<h2 class="text-xl font-bold">${esc(u.steam_name || 'Kullanıcı #' + u.id)}</h2>
								${profileUrl ? `<a href="${profileUrl}" target="_blank" rel="noopener" class="text-xs text-blue-400 hover:underline">Steam profilini aç ↗</a>` : ''}
							</div>
							<button onclick="closeModal()" class="text-gray-500 hover:text-white">✕</button>
						</div>
						<div class="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
							<div class="stat-card"><div class="stat-label">Bakiye</div><div class="stat-value text-lg">${fmtBalance(u.balance)}</div></div>
							<div class="stat-card"><div class="stat-label">Toplam İşlem</div><div class="stat-value text-lg">${txList.length}</div></div>
							<div class="stat-card"><div class="stat-label">Gönderilen</div><div class="stat-value text-lg">${fmtNum(totalCommends)}</div></div>
							<div class="stat-card"><div class="stat-label">Başarısız</div><div class="stat-value text-lg text-red-400">${byStatus.failed || 0}</div></div>
						</div>
						<div class="grid grid-cols-2 gap-3 text-sm mb-4">
							<div><span class="text-gray-500">ID:</span> #${u.id}</div>
							<div><span class="text-gray-500">Steam:</span> <span class="font-mono text-xs">${esc(u.steam_id || '—')}</span></div>
							<div><span class="text-gray-500">Kod:</span> <span class="font-mono text-xs">${esc(u.code || '—')}</span> (başlangıç ${fmtBalance(u.code_initial_balance || 0)})</div>
							<div><span class="text-gray-500">Durum:</span> ${u.banned ? '<span class="text-red-400">Yasaklı</span>' : '<span class="text-green-400">Aktif</span>'}</div>
							<div><span class="text-gray-500">Kayıt:</span> ${fmtDate(u.created_at)}</div>
							<div><span class="text-gray-500">Son aktif:</span> ${fmtDate(u.last_active)}</div>
						</div>
						<div class="card mb-4">
							<h3 class="font-semibold text-sm mb-2">Bakiye</h3>
							<div class="flex items-center gap-2 mb-2"><span class="text-2xl font-bold">${fmtBalance(u.balance)}</span></div>
							<div class="flex gap-2 items-end">
								<div class="flex-1"><label class="label">Değer</label><input id="balNew" type="number" step="1" class="input" placeholder="100 veya -50"></div>
								<button id="balSetAbs" class="btn btn-secondary btn-sm">Mutlak</button>
								<button id="balSetDelta" class="btn btn-primary btn-sm">Delta</button>
							</div>
						</div>
						<div class="card mb-4">
							<h3 class="font-semibold text-sm mb-2">Yasaklama</h3>
							<div class="flex gap-2 items-end">
								<div class="flex-1"><label class="label">Sebep</label><input id="banReason" class="input" placeholder="İsteğe bağlı"></div>
								${u.banned
									? `<button id="unbanBtn" class="btn btn-secondary btn-sm">Yasağı Kaldır</button>`
									: `<button id="banBtn" class="btn btn-danger btn-sm">Yasakla</button>`}
							</div>
						</div>
						<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
							<div class="card max-h-80 overflow-y-auto"><h3 class="font-semibold text-sm mb-2">Oturumlar (${(d.sessions||[]).length})</h3>${sessions}</div>
							<div class="card max-h-80 overflow-y-auto"><h3 class="font-semibold text-sm mb-2">İşlem Geçmişi (${txList.length})</h3>${txs}</div>
							<div class="card md:col-span-2 max-h-60 overflow-y-auto"><h3 class="font-semibold text-sm mb-2">Denetim</h3>${userAudit}</div>
						</div>
					</div>
				`);
				$$('[data-tx-view]').forEach(el => {
					el.addEventListener('click', () => {
						closeModal();
						setTimeout(() => sections.transactions.viewDetail(el.dataset.txView), 100);
					});
				});
				$('#balSetAbs').addEventListener('click', async () => {
					const v = parseFloat($('#balNew').value);
					if (isNaN(v)) return toast('Geçersiz değer', 'error');
					try {
						await api(`/users/${u.id}/balance`, { method: 'PATCH', body: JSON.stringify({ balance: v }) });
						toast('Bakiye güncellendi', 'success');
						closeModal();
						this.load();
					} catch (e) { toast(e.message, 'error'); }
				});
				$('#balSetDelta').addEventListener('click', async () => {
					const v = parseFloat($('#balNew').value);
					if (isNaN(v)) return toast('Geçersiz değer', 'error');
					try {
						await api(`/users/${u.id}/balance`, { method: 'PATCH', body: JSON.stringify({ delta: v }) });
						toast('Bakiye değiştirildi', 'success');
						closeModal();
						this.load();
					} catch (e) { toast(e.message, 'error'); }
				});
				const banBtn = $('#banBtn'), unbanBtn = $('#unbanBtn');
				if (banBtn) banBtn.addEventListener('click', async () => {
					try {
						await api(`/users/${u.id}/ban`, { method: 'PATCH', body: JSON.stringify({ banned: true, reason: $('#banReason').value }) });
						toast('Kullanıcı yasaklandı', 'success');
						closeModal();
						this.load();
					} catch (e) { toast(e.message, 'error'); }
				});
				if (unbanBtn) unbanBtn.addEventListener('click', async () => {
					try {
						await api(`/users/${u.id}/ban`, { method: 'PATCH', body: JSON.stringify({ banned: false }) });
						toast('Yasak kaldırıldı', 'success');
						closeModal();
						this.load();
					} catch (e) { toast(e.message, 'error'); }
				});
				$$('[data-kick]').forEach(b => {
					b.addEventListener('click', async () => {
						try {
							await api(`/users/${u.id}/sessions/${b.dataset.kick}`, { method: 'DELETE' });
							toast('Oturum sonlandırıldı', 'success');
							this.openDrawer(u.id);
						} catch (e) { toast(e.message, 'error'); }
					});
				});
			} catch (e) { toast(e.message, 'error'); }
		}
	};

	sections.codes = {
		async load() {
			const f = state.codeFilters;
			const qp = new URLSearchParams();
			if (f.filter) qp.set('filter', f.filter);
			if (f.search) qp.set('search', f.search);
			qp.set('page', f.page); qp.set('limit', f.limit);
			const data = await api('/codes?' + qp.toString());
			this.render(data);
		},
		render(d) {
			const typeStyles = {
				commend: { label: 'Commend', cls: 'bg-red-500/20 text-red-300' },
				hours:   { label: 'Hours',   cls: 'bg-orange-500/20 text-orange-300' },
				group:   { label: 'Group',   cls: 'bg-indigo-500/20 text-indigo-300' }
			};
			const unitLbl = { commend: 'övgü', hours: 'saat', group: 'üye' };
			const rows = (d.codes || []).map(c => {
				const pt = c.productType || 'commend';
				const ts = typeStyles[pt] || typeStyles.commend;
				const profileUrl = c.steamId && /^\d{17}$/.test(c.steamId) ? `https://steamcommunity.com/profiles/${c.steamId}` : null;
				return `
				<tr class="${c.isUsed ? 'opacity-70' : ''}">
					<td><input type="checkbox" class="code-check" data-id="${c.id}"></td>
					<td class="font-mono text-sm">${esc(c.code)}</td>
					<td><span class="px-2 py-0.5 rounded text-xs font-semibold ${ts.cls}">${ts.label}</span></td>
					<td class="whitespace-nowrap">
						<div>${fmtBalance(c.initialBalance)} <span class="text-xs text-gray-500">${unitLbl[pt] || ''}</span></div>
						<div class="text-xs text-gray-500">kalan ${fmtBalance(c.balance)}</div>
					</td>
					<td>
						${c.isUsed
							? `<span class="status-pill pill-failed">Kullanıldı</span>`
							: `<span class="status-pill pill-online">Kullanılmadı</span>`}
					</td>
					<td>
						${c.isUsed && c.userId
							? `<div class="text-sm">${esc(c.steamName || 'Kullanıcı #'+c.userId)}</div>
							   <div class="text-xs text-gray-500 font-mono">${esc(c.steamId || '')}${profileUrl ? ` · <a href="${profileUrl}" target="_blank" rel="noopener" class="text-blue-400 hover:underline">Steam ↗</a>` : ''}</div>`
							: '<span class="text-gray-500">—</span>'}
					</td>
					<td class="text-xs text-gray-500 whitespace-nowrap">${fmtDateShort(c.createdAt)}</td>
					<td class="text-xs text-gray-500 whitespace-nowrap">${c.expiresAt ? fmtDateShort(c.expiresAt) : '—'}</td>
					<td class="text-right whitespace-nowrap">
						${c.isUsed && c.userId ? `<button class="btn btn-secondary btn-sm" onclick="adminActions.codesViewUser(${c.userId})">Kullanıcı</button>` : ''}
						${!c.isUsed ? `<button class="btn btn-danger btn-sm" onclick="adminActions.codesDelete(${c.id})">Sil</button>` : ''}
					</td>
				</tr>`;
			}).join('');
			const totalPages = d.totalPages || Math.ceil((d.total || 0) / state.codeFilters.limit);
			$('#sectionRoot').innerHTML = `
				<div class="mb-5 flex items-center justify-between flex-wrap gap-2">
					<h1 class="text-2xl font-bold">Kodlar <span class="text-sm text-gray-500 font-normal">(${fmtNum(d.total || 0)})</span></h1>
					<div class="flex gap-2 flex-wrap">
						<button onclick="adminActions.codesGenerate()" class="btn btn-primary btn-sm">+ Kod Üret</button>
						<button id="codeBulkDel" class="btn btn-danger btn-sm">Seçilenleri Sil</button>
						<button id="codeDelUnused" class="btn btn-danger btn-sm">Kullanılmayanları Sil</button>
						<button id="codeExport" class="btn btn-secondary btn-sm">Dışa Aktar</button>
					</div>
				</div>
				<div class="card mb-4 flex flex-wrap gap-3 items-end">
					<div><label class="label">Filtre</label><select id="codeFilter" class="select w-40"><option value="">Hepsi</option><option value="unused">Kullanılmayan</option><option value="used">Kullanılan</option><option value="expired">Süresi Dolmuş</option></select></div>
					<div class="flex-1 min-w-[200px]"><label class="label">Arama</label><input id="codeSearch" class="input" placeholder="Kod, Steam ID veya isim" value="${esc(state.codeFilters.search)}"></div>
					<button id="codeApply" class="btn btn-primary btn-sm">Uygula</button>
				</div>
				<div class="card overflow-x-auto">
					<table class="table">
						<thead><tr>
							<th><input type="checkbox" id="codeSelectAll"></th>
							<th>Kod</th><th>Tip</th><th>Bakiye</th><th>Durum</th><th>Kullanıcı</th><th>Oluşturma</th><th>Son Kullanma</th><th></th>
						</tr></thead>
						<tbody>${rows || '<tr><td colspan="9" class="text-center text-gray-500 py-6">Kod yok</td></tr>'}</tbody>
					</table>
					${paginate(state.codeFilters.page, totalPages)}
				</div>
			`;
			$('#codeSelectAll').addEventListener('change', (e) => {
				$$('.code-check').forEach(c => c.checked = e.target.checked);
			});
			$('#codeFilter').value = state.codeFilters.filter;
			$('#codeApply').addEventListener('click', () => {
				state.codeFilters.filter = $('#codeFilter').value;
				state.codeFilters.search = $('#codeSearch').value.trim();
				state.codeFilters.page = 1;
				this.load();
			});
			$('#codeBulkDel').addEventListener('click', () => this.bulkDelete());
			$('#codeDelUnused').addEventListener('click', () => this.deleteAllUnused());
			$('#codeExport').addEventListener('click', () => this.exportCodes());
			bindPagination($('#sectionRoot'), (p) => { state.codeFilters.page = p; this.load(); });
		},
		async deleteOne(id) {
			if (!confirmAction('Kodu sil?')) return;
			try {
				await api('/codes/' + id, { method: 'DELETE' });
				toast('Silindi', 'success');
				this.load();
			} catch (e) { toast(e.message, 'error'); }
		},
		generateModal() {
			openModal(`
				<div class="p-6">
					<h2 class="text-xl font-bold mb-4">Kod Üret</h2>
					<div class="mb-3"><label class="label">Ürün Tipi</label>
						<select id="genProductType" class="select">
							<option value="commend">Commend (övgü)</option>
							<option value="hours">Hours Boost (saat)</option>
							<option value="group">Group Members (grup üye)</option>
						</select>
						<p class="text-xs text-gray-500 mt-1">Kod tipine göre bakiye birim değişir: commend→övgü, hours→saat, group→üye.</p>
					</div>
					<div class="mb-3"><label class="label">Adet (1-100)</label><input id="genCount" type="number" class="input" value="10" min="1" max="100"></div>
					<div class="mb-3"><label class="label"><span id="genBalanceLabel">Bakiye (övgü hakkı)</span></label><input id="genBalance" type="number" class="input" value="50" min="1"></div>
					<div class="mb-4"><label class="label">Son Kullanma (opsiyonel)</label><input id="genExpires" type="datetime-local" class="input"></div>
					<div id="genResult" class="mb-4"></div>
					<div class="flex justify-end gap-2">
						<button onclick="closeModal()" class="btn btn-secondary btn-sm">Kapat</button>
						<button onclick="adminActions.codesGenerateSubmit()" class="btn btn-primary btn-sm">Üret</button>
					</div>
				</div>
			`);
			const labels = {
				commend: 'Bakiye (övgü hakkı)',
				hours:   'Bakiye (saat)',
				group:   'Bakiye (üye)'
			};
			const defaults = { commend: 50, hours: 500, group: 500 };
			const sel = $('#genProductType');
			const bal = $('#genBalance');
			const lbl = $('#genBalanceLabel');
			if (sel) sel.addEventListener('change', () => {
				const pt = sel.value;
				if (lbl) lbl.textContent = labels[pt] || labels.commend;
				if (bal) bal.value = defaults[pt] || 50;
			});
		},
		async generateSubmit() {
			try {
				const body = {
					count: parseInt($('#genCount').value),
					balance: parseInt($('#genBalance').value),
					productType: ($('#genProductType') && $('#genProductType').value) || 'commend'
				};
				const exp = $('#genExpires').value;
				if (exp) body.expiresAt = exp;
				const r = await api('/codes/generate', { method: 'POST', body: JSON.stringify(body) });
				const list = (r.codes || []).map(c => c.code).join('\n');
				$('#genResult').innerHTML = `<div class="bg-[#0c0c11] rounded p-3 text-xs font-mono max-h-48 overflow-y-auto whitespace-pre">${esc(list)}</div>`;
				toast(`${r.generated || 0} kod üretildi (${body.productType})`, 'success');
				this.load();
			} catch (e) { toast(e.message, 'error'); }
		},
		async bulkDelete() {
			const ids = Array.from($$('.code-check')).filter(c => c.checked).map(c => parseInt(c.dataset.id));
			if (!ids.length) return toast('Seçim yok', 'info');
			if (!confirmAction(`${ids.length} kod silinsin mi?`)) return;
			try {
				const r = await api('/codes/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) });
				toast(`${r.deleted || 0} silindi`, 'success');
				this.load();
			} catch (e) { toast(e.message, 'error'); }
		},
		async deleteAllUnused() {
			if (!confirmAction('Tüm kullanılmayan kodları silmek istediğinize emin misiniz?')) return;
			try {
				const r = await api('/codes/bulk-delete', { method: 'POST', body: JSON.stringify({ filter: 'unused' }) });
				toast(`${r.deleted || 0} silindi`, 'success');
				this.load();
			} catch (e) { toast(e.message, 'error'); }
		},
		async exportCodes() {
			try {
				const data = await api('/codes/export');
				const lines = ['code,balance', ...data.map(c => `${c.code},${c.balance}`)];
				const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url; a.download = `codes-${Date.now()}.csv`; a.click();
				URL.revokeObjectURL(url);
			} catch (e) { toast(e.message, 'error'); }
		}
	};

	sections.resellers = {
		state: { page: 1, limit: 20, search: '', status: '' },
		async load() {
			const qp = new URLSearchParams();
			qp.set('page', this.state.page);
			qp.set('limit', this.state.limit);
			if (this.state.search) qp.set('search', this.state.search);
			if (this.state.status) qp.set('status', this.state.status);
			const d = await api('/resellers?' + qp.toString());
			this.render(d);
		},
		render(d) {
			const fmt = (n, unit) => n === -1 ? '∞' : (n === 0 ? '—' : (n.toLocaleString('tr') + (unit ? ' ' + unit : '')));
			const rows = (d.resellers || []).map(r => {
				const statusPill = r.status === 'active'
					? '<span class="status-pill pill-online">Aktif</span>'
					: '<span class="status-pill pill-failed">Askıda</span>';
				const tierMap = {
					standard: 'bg-gray-500/20 text-gray-300',
					bronze: 'bg-orange-800/30 text-orange-300',
					silver: 'bg-gray-400/20 text-gray-200',
					gold: 'bg-yellow-500/20 text-yellow-300',
					platinum: 'bg-indigo-500/20 text-indigo-300'
				};
				return `
				<tr>
					<td><span class="font-mono text-sm">#${r.id}</span></td>
					<td>
						<div class="font-semibold">${esc(r.username)}</div>
						<div class="text-xs text-gray-500">${esc(r.display_name || '')}</div>
					</td>
					<td><span class="px-2 py-0.5 rounded text-xs font-semibold ${tierMap[r.tier] || tierMap.standard}">${esc(r.tier || 'standard')}</span></td>
					<td>${statusPill}</td>
					<td class="text-xs">
						<div>Commend: <strong>${fmt(r.usage_commend)}</strong>/${fmt(r.limit_commend)}</div>
						<div>Hours:&nbsp;&nbsp; <strong>${fmt(r.usage_hours)}</strong>/${fmt(r.limit_hours)}</div>
						<div>Group:&nbsp;&nbsp; <strong>${fmt(r.usage_group)}</strong>/${fmt(r.limit_group)}</div>
					</td>
					<td class="text-xs text-gray-500 whitespace-nowrap">${r.total_codes || 0} kod</td>
					<td class="text-xs text-gray-500 whitespace-nowrap">${r.last_login ? fmtDateShort(r.last_login) : 'Hiç'}</td>
					<td class="text-right whitespace-nowrap">
						<button class="btn btn-secondary btn-sm" onclick="adminActions.resellerEdit(${r.id})">Düzenle</button>
						<button class="btn btn-secondary btn-sm" onclick="adminActions.resellerViewCodes(${r.id})">Kodlar</button>
						<button class="btn btn-danger btn-sm" onclick="adminActions.resellerDelete(${r.id}, '${esc(r.username)}')">Sil</button>
					</td>
				</tr>`;
			}).join('');
			const totalPages = d.totalPages || Math.ceil((d.total || 0) / this.state.limit);
			$('#sectionRoot').innerHTML = `
				<div class="mb-5 flex items-center justify-between flex-wrap gap-2">
					<h1 class="text-2xl font-bold">Bayilikler <span class="text-sm text-gray-500 font-normal">(${fmtNum(d.total || 0)})</span></h1>
					<button onclick="adminActions.resellerCreate()" class="btn btn-primary btn-sm">+ Yeni Bayi</button>
				</div>
				<div class="card mb-4 flex flex-wrap gap-3 items-end">
					<div><label class="label">Durum</label>
						<select id="rSelStatus" class="select w-40">
							<option value="">Hepsi</option>
							<option value="active">Aktif</option>
							<option value="suspended">Askıda</option>
						</select>
					</div>
					<div class="flex-1 min-w-[200px]"><label class="label">Arama</label><input id="rSearch" class="input" placeholder="Kullanıcı adı, görünen ad, iletişim" value="${esc(this.state.search)}"></div>
					<button id="rApply" class="btn btn-primary btn-sm">Uygula</button>
				</div>
				<div class="card overflow-x-auto">
					<table class="table">
						<thead><tr><th>ID</th><th>Kullanıcı</th><th>Tier</th><th>Durum</th><th>Aylık Kullanım</th><th>Toplam</th><th>Son Giriş</th><th></th></tr></thead>
						<tbody>${rows || '<tr><td colspan="8" class="text-center text-gray-500 py-6">Bayi yok</td></tr>'}</tbody>
					</table>
					${paginate(this.state.page, totalPages)}
				</div>
			`;
			$('#rSelStatus').value = this.state.status;
			$('#rApply').addEventListener('click', () => {
				this.state.status = $('#rSelStatus').value;
				this.state.search = $('#rSearch').value.trim();
				this.state.page = 1;
				this.load();
			});
			bindPagination($('#sectionRoot'), (p) => { this.state.page = p; this.load(); });
		},
		createModal() {
			openModal(`
				<div class="p-6">
					<h2 class="text-xl font-bold mb-4">Yeni Bayi</h2>
					<div class="grid grid-cols-2 gap-3 mb-3">
						<div>
							<label class="label">Kullanıcı Adı *</label>
							<input id="nrUsername" class="input" placeholder="bayi_adi" autocomplete="off">
							<p class="text-xs text-gray-500 mt-1">3-32 karakter, küçük harf/rakam/_/-</p>
						</div>
						<div>
							<label class="label">Şifre *</label>
							<input id="nrPassword" type="password" class="input" placeholder="En az 6 karakter" autocomplete="new-password">
						</div>
						<div>
							<label class="label">Görünen Ad</label>
							<input id="nrDisplay" class="input" placeholder="opsiyonel">
						</div>
						<div>
							<label class="label">İletişim</label>
							<input id="nrContact" class="input" placeholder="Discord / E-posta">
						</div>
					</div>
					<div class="mb-4">
						<label class="label">Tier</label>
						<select id="nrTier" class="select">
							<option value="standard">Standard</option>
							<option value="bronze">Bronze</option>
							<option value="silver">Silver</option>
							<option value="gold">Gold</option>
							<option value="platinum">Platinum</option>
						</select>
					</div>
					<div class="border-t border-[#252530] pt-4 mb-4">
						<h3 class="font-semibold mb-3">Aylık Limitler</h3>
						<p class="text-xs text-gray-500 mb-3">0 = yetkisiz · -1 = sınırsız · diğer sayılar = aylık tavan (birim × adet toplamı)</p>
						<div class="grid grid-cols-3 gap-3">
							<div>
								<label class="label">Commend</label>
								<input id="nrLimC" class="input" type="number" value="0">
							</div>
							<div>
								<label class="label">Hours</label>
								<input id="nrLimH" class="input" type="number" value="0">
							</div>
							<div>
								<label class="label">Group</label>
								<input id="nrLimG" class="input" type="number" value="0">
							</div>
						</div>
					</div>
					<div class="mb-4">
						<label class="label">Notlar</label>
						<textarea id="nrNotes" class="input" rows="2" placeholder="Dahili notlar (sadece admin görür)"></textarea>
					</div>
					<div class="flex justify-end gap-2">
						<button onclick="closeModal()" class="btn btn-secondary btn-sm">İptal</button>
						<button onclick="adminActions.resellerCreateSubmit()" class="btn btn-primary btn-sm">Oluştur</button>
					</div>
				</div>
			`);
		},
		async createSubmit() {
			try {
				const body = {
					username: $('#nrUsername').value.trim(),
					password: $('#nrPassword').value,
					displayName: $('#nrDisplay').value.trim() || null,
					contact: $('#nrContact').value.trim() || null,
					tier: $('#nrTier').value,
					notes: $('#nrNotes').value.trim() || null,
					limitCommend: parseInt($('#nrLimC').value, 10) || 0,
					limitHours: parseInt($('#nrLimH').value, 10) || 0,
					limitGroup: parseInt($('#nrLimG').value, 10) || 0
				};
				await api('/resellers', { method: 'POST', body: JSON.stringify(body) });
				closeModal();
				toast('Bayi oluşturuldu', 'success');
				this.load();
			} catch (e) {
				const map = {
					invalid_username: 'Kullanıcı adı geçersiz (3-32 karakter, küçük harf/rakam/_/-)',
					weak_password: 'Şifre en az 6 karakter olmalı',
					username_taken: 'Bu kullanıcı adı kullanılmış'
				};
				toast(map[e.message] || e.message, 'error');
			}
		},
		async editModal(id) {
			try {
				const d = await api('/resellers?page=1&limit=1000');
				const r = (d.resellers || []).find(x => x.id === id);
				if (!r) return toast('Bayi bulunamadı', 'error');

				openModal(`
					<div class="p-6">
						<h2 class="text-xl font-bold mb-1">${esc(r.username)}</h2>
						<p class="text-xs text-gray-500 mb-4">ID #${r.id} · ${r.total_codes || 0} kod · Kayıt: ${fmtDateShort(r.created_at)}</p>

						<div class="grid grid-cols-2 gap-3 mb-4">
							<div>
								<label class="label">Görünen Ad</label>
								<input id="erDisplay" class="input" value="${esc(r.display_name || '')}">
							</div>
							<div>
								<label class="label">İletişim</label>
								<input id="erContact" class="input" value="${esc(r.contact || '')}">
							</div>
							<div>
								<label class="label">Tier</label>
								<select id="erTier" class="select">
									${['standard','bronze','silver','gold','platinum'].map(t =>
										`<option value="${t}" ${r.tier === t ? 'selected' : ''}>${t}</option>`
									).join('')}
								</select>
							</div>
							<div>
								<label class="label">Durum</label>
								<select id="erStatus" class="select">
									<option value="active" ${r.status === 'active' ? 'selected' : ''}>Aktif</option>
									<option value="suspended" ${r.status === 'suspended' ? 'selected' : ''}>Askıda</option>
								</select>
							</div>
						</div>

						<div class="border-t border-[#252530] pt-4 mb-4">
							<h3 class="font-semibold mb-2">Aylık Limitler</h3>
							<p class="text-xs text-gray-500 mb-3">0 = yetkisiz · -1 = sınırsız · diğer = aylık tavan</p>
							<div class="grid grid-cols-3 gap-3">
								<div><label class="label">Commend <span class="text-xs text-gray-500">(kullanılan: ${r.usage_commend})</span></label><input id="erLimC" class="input" type="number" value="${r.limit_commend}"></div>
								<div><label class="label">Hours <span class="text-xs text-gray-500">(kullanılan: ${r.usage_hours})</span></label><input id="erLimH" class="input" type="number" value="${r.limit_hours}"></div>
								<div><label class="label">Group <span class="text-xs text-gray-500">(kullanılan: ${r.usage_group})</span></label><input id="erLimG" class="input" type="number" value="${r.limit_group}"></div>
							</div>
						</div>

						<div class="border-t border-[#252530] pt-4 mb-4">
							<h3 class="font-semibold mb-2">Yönetim İşlemleri</h3>
							<div class="grid grid-cols-2 gap-3">
								<div>
									<label class="label">Şifre Değiştir</label>
									<div class="flex gap-2">
										<input id="erNewPass" type="password" class="input flex-1" placeholder="Yeni şifre">
										<button class="btn btn-secondary btn-sm" onclick="adminActions.resellerResetPassword(${r.id})">Uygula</button>
									</div>
								</div>
								<div>
									<label class="label">Aylık Kullanım Sıfırla</label>
									<button class="btn btn-secondary btn-sm w-full" onclick="adminActions.resellerResetUsage(${r.id})">Sıfırla</button>
								</div>
							</div>
						</div>

						<div class="flex justify-between gap-2">
							<button onclick="closeModal()" class="btn btn-secondary btn-sm">Kapat</button>
							<button onclick="adminActions.resellerEditSubmit(${r.id})" class="btn btn-primary btn-sm">Kaydet</button>
						</div>
					</div>
				`);
			} catch (e) { toast(e.message, 'error'); }
		},
		async editSubmit(id) {
			try {
				const body = {
					displayName: $('#erDisplay').value.trim() || null,
					contact: $('#erContact').value.trim() || null,
					tier: $('#erTier').value,
					status: $('#erStatus').value,
					limitCommend: parseInt($('#erLimC').value, 10),
					limitHours: parseInt($('#erLimH').value, 10),
					limitGroup: parseInt($('#erLimG').value, 10)
				};
				await api('/resellers/' + id, { method: 'PATCH', body: JSON.stringify(body) });
				closeModal();
				toast('Güncellendi', 'success');
				this.load();
			} catch (e) { toast(e.message, 'error'); }
		},
		async resetPassword(id) {
			const pass = $('#erNewPass').value;
			if (!pass || pass.length < 6) return toast('Şifre en az 6 karakter olmalı', 'error');
			try {
				await api('/resellers/' + id + '/reset-password', { method: 'POST', body: JSON.stringify({ password: pass }) });
				$('#erNewPass').value = '';
				toast('Şifre sıfırlandı — tüm aktif oturumlar iptal edildi', 'success');
			} catch (e) { toast(e.message, 'error'); }
		},
		async resetUsage(id) {
			if (!confirmAction('Bu bayinin aylık kullanım sayaçlarını sıfırlamak istediğinize emin misiniz?')) return;
			try {
				await api('/resellers/' + id + '/reset-usage', { method: 'POST' });
				toast('Kullanım sıfırlandı', 'success');
				closeModal();
				this.load();
			} catch (e) { toast(e.message, 'error'); }
		},
		async deleteOne(id, username) {
			if (!confirmAction(`"${username}" bayisini silmek istediğinize emin misiniz? Bu geri alınamaz.`)) return;
			try {
				await api('/resellers/' + id, { method: 'DELETE' });
				toast('Silindi', 'success');
				this.load();
			} catch (e) { toast(e.message, 'error'); }
		},
		async viewCodes(id) {
			try {
				const d = await api('/resellers/' + id + '/codes?page=1&limit=50');
				const rows = (d.codes || []).map(c => `
					<tr>
						<td class="font-mono text-sm">${esc(c.code)}</td>
						<td><span class="px-2 py-0.5 rounded text-xs">${esc(c.product_type || 'commend')}</span></td>
						<td>${fmtBalance(c.initial_balance)}</td>
						<td>${c.is_used ? '<span class="status-pill pill-failed">Kullanıldı</span>' : '<span class="status-pill pill-online">Kullanılmadı</span>'}</td>
						<td class="text-xs text-gray-500">${fmtDateShort(c.created_at)}</td>
					</tr>
				`).join('') || '<tr><td colspan="5" class="text-center text-gray-500 py-4">Kod yok</td></tr>';
				openModal(`
					<div class="p-6">
						<h2 class="text-xl font-bold mb-4">Bayi Kodları <span class="text-sm text-gray-500 font-normal">(toplam ${d.total})</span></h2>
						<div class="overflow-x-auto max-h-96 overflow-y-auto">
							<table class="table">
								<thead class="sticky top-0 bg-[#14141c]"><tr><th>Kod</th><th>Tip</th><th>Bakiye</th><th>Durum</th><th>Oluşturma</th></tr></thead>
								<tbody>${rows}</tbody>
							</table>
						</div>
						<div class="flex justify-end mt-4">
							<button onclick="closeModal()" class="btn btn-secondary btn-sm">Kapat</button>
						</div>
					</div>
				`);
			} catch (e) { toast(e.message, 'error'); }
		}
	};

	sections.ggsel = {
		state: { tab: 'dashboard', settings: null, cache: {} },

		_d(r) {
			if (!r || !r.ok) return null;
			if (r.data && Object.prototype.hasOwnProperty.call(r.data, 'data')) return r.data.data;
			return r.data;
		},
		_pag(r) {
			if (r && r.data && r.data.pagination) return r.data.pagination;
			return null;
		},

		async load() {
			this.state.settings = await api('/ggsel/settings').catch(() => null);
			this.render();
			this.loadTab(this.state.tab);
		},

		render() {
			const s = this.state.settings || {};
			const connected = !!s.hasToken;
			const expired = s.expired === true;

			$('#sectionRoot').innerHTML = `
				<div class="mb-5">
					<h1 class="text-2xl font-bold mb-2">🛒 GGSel Mağaza</h1>
					<p class="text-sm text-gray-500 mb-4">GGsel marketplace tüm özellikleri (ürün, sipariş, mesaj, cüzdan, çekim, yorum) entegre.</p>

					<div class="ggsel-tabs flex flex-wrap gap-2 mb-4">
						${[
							['dashboard','📊 Özet'],
							['orders','📦 Siparişler'],
							['offers','🛍️ Ürünler'],
							['chats','💬 Mesajlar'],
							['account','💰 Hesap'],
							['wallets','👛 Cüzdan'],
							['categories','📁 Kategoriler'],
							['apikeys','🔑 API Key'],
							['settings','⚙️ Ayarlar']
						].map(([t,l]) => `
							<button class="ggsel-tab btn btn-sm ${this.state.tab === t ? 'btn-primary' : 'btn-secondary'}" data-gtab="${t}">${l}</button>
						`).join('')}
					</div>

					${connected ? `
						<div class="card mb-3" style="background: ${expired ? 'rgba(241, 196, 15, 0.08)' : 'rgba(39, 174, 96, 0.08)'}; border: 1px solid ${expired ? 'rgba(241, 196, 15, 0.2)' : 'rgba(39, 174, 96, 0.2)'};">
							<div class="flex items-center gap-3 flex-wrap">
								<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${expired?'#f1c40f':'#27ae60'};"></span>
								<span class="text-sm font-semibold" style="color:${expired?'#f1c40f':'#27ae60'};">${expired ? 'Token süresi dolmuş olabilir' : 'Bağlı'}</span>
								<span class="text-xs text-gray-500">${esc(s.email || '')}</span>
								<span class="text-xs text-gray-500" style="margin-left:auto;">
									${s.expiresAt ? 'Bitiş: ' + new Date(s.expiresAt).toLocaleString('tr-TR') : ''}
								</span>
							</div>
							<div class="flex gap-2 mt-2 flex-wrap">
								<button class="btn btn-secondary btn-sm" id="ggTestConn">Test Bağlantı</button>
								<button class="btn btn-danger btn-sm" id="ggLogout">Çıkış</button>
							</div>
						</div>
					` : `
						<div class="card mb-3" style="background: rgba(231, 76, 60, 0.08); border: 1px solid rgba(231, 76, 60, 0.2);">
							<div class="font-semibold text-red-400 mb-1">⚠️ Bağlı değil</div>
							<div class="text-xs text-gray-400 mb-2">Ayarlar sekmesinden GGsel hesabınla giriş yap.</div>
							<button class="btn btn-primary btn-sm" id="ggGotoSettings">Ayarlara git</button>
						</div>
					`}

					<div id="ggselContent"></div>
				</div>

				<style>
					.ggsel-tabs { overflow-x: auto; -webkit-overflow-scrolling: touch; }
					.ggsel-tab { white-space: nowrap; }
					.gg-card { background:#1a1a24; border:1px solid #252530; border-radius:10px; padding:1rem; }
					.gg-stat { background:#1a1a24; border:1px solid #252530; border-radius:10px; padding:1rem; }
					.gg-stat .label { font-size:0.7rem; color:#6b6b78; text-transform:uppercase; letter-spacing:0.05em; }
					.gg-stat .value { font-size:1.4rem; font-weight:800; color:#fff; margin-top:0.3rem; word-break:break-word; }
					.gg-stat .delta { font-size:0.7rem; color:#7d7d8a; margin-top:0.2rem; }
					.gg-stat .delta.up { color:#27ae60; }
					.gg-stat .delta.down { color:#e74c3c; }
					.gg-list-item { background:#1a1a24; border:1px solid #252530; border-radius:8px; padding:0.85rem; margin-bottom:0.5rem; }
					.gg-list-item:hover { border-color:#3a3a4a; }
					.gg-pre { background:#0c0c11; border:1px solid #252530; border-radius:6px; padding:0.7rem; font-size:0.72rem; max-height:280px; overflow:auto; white-space:pre-wrap; word-break:break-all; }
					.gg-input, .gg-select { width:100%; padding:0.65rem; background:#1a1a24; border:1px solid #252530; border-radius:8px; color:#fff; font-size:0.88rem; }
					.gg-input:focus, .gg-select:focus { border-color:#c0392b; outline:none; }
					.gg-grid { display:grid; gap:0.75rem; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); }
					.gg-pill { display:inline-block; padding:0.15rem 0.5rem; border-radius:999px; font-size:0.65rem; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; }
					.gg-pill.active { background:rgba(39, 174, 96, 0.15); color:#27ae60; }
					.gg-pill.paused { background:rgba(241, 196, 15, 0.15); color:#f1c40f; }
					.gg-pill.draft { background:rgba(149, 165, 166, 0.15); color:#95a5a6; }
					.gg-avatar { width:32px; height:32px; border-radius:50%; background:#252530; }
				</style>
			`;

			$$('.ggsel-tab').forEach(b => b.addEventListener('click', (e) => {
				const t = e.currentTarget.dataset.gtab;
				this.state.tab = t;
				this.render();
				this.loadTab(t);
			}));

			const $btn = (id, fn) => { const e = $(id); if (e) e.addEventListener('click', fn); };
			$btn('#ggTestConn', () => this.testConnection());
			$btn('#ggLogout', () => this.doLogout());
			$btn('#ggGotoSettings', () => { this.state.tab = 'settings'; this.render(); this.loadTab('settings'); });
		},

		async loadTab(tab) {
			const el = $('#ggselContent');
			if (!el) return;
			el.innerHTML = '<div class="text-gray-500 text-sm py-4">Yükleniyor...</div>';
			try {
				if (tab === 'dashboard')      await this.renderDashboard(el);
				else if (tab === 'orders')    await this.renderOrders(el);
				else if (tab === 'offers')    await this.renderOffers(el);
				else if (tab === 'chats')     await this.renderChats(el);
				else if (tab === 'account')   await this.renderAccount(el);
				else if (tab === 'wallets')   await this.renderWallets(el);
				else if (tab === 'categories') await this.renderCategories(el);
				else if (tab === 'apikeys')   await this.renderApiKeys(el);
				else if (tab === 'settings')  await this.renderSettings(el);
			} catch (err) {
				el.innerHTML = `<div class="card text-red-400 text-sm">Hata: ${esc(err.message)}</div>`;
			}
		},

		async renderDashboard(el) {
			const [bal, dash, me] = await Promise.all([
				api('/ggsel/account/balance').catch(e => ({ ok:false, error:e.message })),
				api('/ggsel/dashboard').catch(e => ({ ok:false, error:e.message })),
				api('/ggsel/users/me').catch(e => ({ ok:false, error:e.message }))
			]);

			const balData = this._d(bal) || {};
			const dashData = this._d(dash) || {};
			const meData = this._d(me) || {};
			const stat = dashData.statistic || {};

			const fmtMoney = (v) => (v == null || v === '' ? '—' : (typeof v === 'number' ? v.toFixed(2) : v));
			const sign = (n) => n > 0 ? '↑' : n < 0 ? '↓' : '·';
			const cls = (n) => n > 0 ? 'up' : n < 0 ? 'down' : '';

			el.innerHTML = `
				<div class="gg-grid mb-3">
					<div class="gg-stat">
						<div class="label">Bakiye</div>
						<div class="value">${esc(fmtMoney(balData.amount))} <span style="font-size:0.7rem; color:#6b6b78;">RUB</span></div>
						${balData.amount_in_hold != null ? `<div class="delta">Beklemede: ${esc(fmtMoney(balData.amount_in_hold))} RUB</div>` : ''}
					</div>
					<div class="gg-stat">
						<div class="label">Gelir (toplam)</div>
						<div class="value">${esc(stat.revenue ? fmtMoney(stat.revenue.value) : '—')} <span style="font-size:0.7rem; color:#6b6b78;">RUB</span></div>
						${stat.revenue ? `<div class="delta ${cls(stat.revenue.stats)}">${sign(stat.revenue.stats)} ${Math.abs(stat.revenue.stats || 0)}%</div>` : ''}
					</div>
					<div class="gg-stat">
						<div class="label">Satış</div>
						<div class="value">${esc(stat.sales ? String(stat.sales.value) : '0')}</div>
						${stat.sales ? `<div class="delta ${cls(stat.sales.stats)}">${sign(stat.sales.stats)} ${Math.abs(stat.sales.stats || 0)}%</div>` : ''}
					</div>
					<div class="gg-stat">
						<div class="label">Görüntülenme</div>
						<div class="value">${esc(stat.views ? String(stat.views.value) : '0')}</div>
						${stat.views ? `<div class="delta ${cls(stat.views.stats)}">${sign(stat.views.stats)} ${Math.abs(stat.views.stats || 0)}%</div>` : ''}
					</div>
					<div class="gg-stat">
						<div class="label">Dönüşüm</div>
						<div class="value">${esc(stat.conversion ? String(stat.conversion.value) + '%' : '—')}</div>
						${stat.conversion ? `<div class="delta ${cls(stat.conversion.stats)}">${sign(stat.conversion.stats)} ${Math.abs(stat.conversion.stats || 0)}%</div>` : ''}
					</div>
				</div>

				<div class="gg-card mb-3">
					<div class="flex items-center gap-3 mb-3">
						${meData.avatar_url ? `<img class="gg-avatar" src="${esc(meData.avatar_url)}" alt="">` : '<div class="gg-avatar"></div>'}
						<div>
							<div class="font-semibold">${esc(meData.username || '—')}</div>
							<div class="text-xs text-gray-500">${esc(meData.email || '')}</div>
						</div>
						<div style="margin-left:auto; text-align:right;">
							<div class="text-xs text-gray-500">GGsel ID</div>
							<div class="font-mono text-sm">${esc(String(meData.ggsel_id || meData.id || '—'))}</div>
						</div>
					</div>
					${meData.has_new_messages ? `<div class="text-xs" style="color:#f1c40f;">📬 ${esc(String(meData.new_messages_count || 0))} okunmamış mesaj</div>` : ''}
				</div>

				<details class="gg-card">
					<summary class="cursor-pointer text-sm text-gray-400">🧪 Ham yanıtlar</summary>
					<div class="mt-2"><div class="text-xs text-gray-500 mb-1">Bakiye</div><div class="gg-pre">${esc(JSON.stringify(bal, null, 2))}</div></div>
					<div class="mt-2"><div class="text-xs text-gray-500 mb-1">Dashboard</div><div class="gg-pre">${esc(JSON.stringify(dash, null, 2))}</div></div>
					<div class="mt-2"><div class="text-xs text-gray-500 mb-1">Profil</div><div class="gg-pre">${esc(JSON.stringify(me, null, 2))}</div></div>
				</details>
			`;
		},

		async renderOrders(el) {
			el.innerHTML = `
				<div class="gg-card mb-3">
					<div class="flex items-center justify-between flex-wrap gap-2 mb-3">
						<h3 class="font-semibold">Siparişler</h3>
						<div class="flex gap-2 items-center">
							<select class="gg-select" id="ggOrderFilter" style="width:auto; min-width:140px;">
								<option value="">Tümü</option>
								<option value="paid">Ödenmiş</option>
								<option value="delivered">Teslim Edildi</option>
								<option value="pending">Beklemede</option>
								<option value="refunded">İade</option>
								<option value="cancelled">İptal</option>
							</select>
							<button class="btn btn-primary btn-sm" id="ggReloadOrders">↻</button>
						</div>
					</div>
					<div id="ggOrdersList"><div class="text-gray-500 text-sm">Yükleniyor...</div></div>
				</div>

				<div class="gg-card">
					<h3 class="font-semibold mb-2">Sipariş Detay</h3>
					<div class="flex gap-2 flex-wrap">
						<input class="gg-input" id="ggOrderId" placeholder="Order ID" style="flex:1; min-width:180px;">
						<button class="btn btn-primary btn-sm" id="ggLookupOrder">Aç</button>
					</div>
					<div id="ggOrderDetail" class="mt-3"></div>
				</div>
			`;

			const loadList = async () => {
				const lst = $('#ggOrdersList');
				const status = $('#ggOrderFilter').value;
				lst.innerHTML = '<div class="text-gray-500 text-sm">Yükleniyor...</div>';
				const params = status ? '?status=' + encodeURIComponent(status) : '';
				const r = await api('/ggsel/orders' + params).catch(e => ({ ok:false, error:e.message }));
				if (!r.ok) {
					lst.innerHTML = `<div class="text-red-400 text-sm mb-2">Hata: ${esc(r.error || 'unknown')}</div><div class="gg-pre">${esc(JSON.stringify(r, null, 2))}</div>`;
					return;
				}
				const items = this._d(r) || [];
				const pag = this._pag(r);
				if (!Array.isArray(items) || !items.length) {
					lst.innerHTML = `<div class="text-gray-500 text-sm">Sipariş yok.</div>`;
					return;
				}
				lst.innerHTML = `
					${pag ? `<div class="text-xs text-gray-500 mb-2">Toplam: ${esc(String(pag.total_count || items.length))} sipariş · Sayfa ${esc(String(pag.page||1))}/${esc(String(pag.total_pages||1))}</div>` : ''}
					${items.map(o => {
						const stat = (o.status || '').toLowerCase();
						const pillCls = stat === 'paid' || stat === 'delivered' ? 'pill-online' : (stat === 'pending' ? 'pill-pending' : (stat === 'refunded' || stat === 'cancelled' ? 'pill-failed' : 'pill-pending'));
						const dateStr = o.payment_date || o.created_at || '';
						const date = dateStr ? new Date(dateStr).toLocaleString('tr-TR') : '';
						return `
						<div class="gg-list-item" style="cursor:pointer;" data-oid="${esc(String(o.id||''))}">
							<div class="flex justify-between items-start gap-2 flex-wrap">
								<div style="flex:1; min-width:200px;">
									<div class="font-semibold text-sm">#${esc(String(o.id || '?'))}</div>
									<div class="text-xs text-gray-400 mt-1">${esc(o.offer_title || '')}</div>
									<div class="text-xs text-gray-500 mt-1">Adet: ${esc(String(o.quantity || 1))}${o.processed_review ? ' · ✓ değerlendirildi' : ''}</div>
								</div>
								<div class="text-right">
									<div class="text-sm font-bold">${esc(String(o.amount || o.total || o.price || '?'))} ${esc(o.currency || 'RUB')}</div>
									<span class="status-pill ${pillCls}">${esc(o.status || '?')}</span>
									<div class="text-xs text-gray-500 mt-1">${esc(date)}</div>
								</div>
							</div>
						</div>`;
					}).join('')}
				`;
				$$('#ggOrdersList .gg-list-item[data-oid]').forEach(it => it.addEventListener('click', () => {
					$('#ggOrderId').value = it.dataset.oid;
					$('#ggLookupOrder').click();
				}));
			};

			$('#ggReloadOrders').addEventListener('click', loadList);
			$('#ggOrderFilter').addEventListener('change', loadList);
			$('#ggLookupOrder').addEventListener('click', async () => {
				const id = $('#ggOrderId').value.trim();
				if (!id) return;
				const det = $('#ggOrderDetail');
				det.innerHTML = '<div class="text-gray-500 text-sm">Yükleniyor...</div>';
				const r = await api('/ggsel/orders/' + encodeURIComponent(id)).catch(e => ({ ok:false, error:e.message }));
				const data = this._d(r);
				if (!r.ok || !data) {
					det.innerHTML = `<div class="text-red-400 text-sm">${esc(r.error || 'Bulunamadı')}</div>`;
					return;
				}
				det.innerHTML = `
					<div class="gg-grid mb-2">
						<div class="gg-stat"><div class="label">Durum</div><div class="value" style="font-size:1rem;">${esc(data.status || '—')}</div></div>
						<div class="gg-stat"><div class="label">Tutar</div><div class="value" style="font-size:1rem;">${esc(String(data.amount || data.price || '?'))} ${esc(data.currency || 'RUB')}</div></div>
						<div class="gg-stat"><div class="label">Adet</div><div class="value" style="font-size:1rem;">${esc(String(data.quantity || 1))}</div></div>
					</div>
					<div class="gg-card mb-2">
						<div class="font-semibold mb-1">${esc(data.offer_title || '—')}</div>
						<div class="text-xs text-gray-500">Offer ID: ${esc(String(data.offer_id || ''))}${data.offer_ggsel_id ? ' · GGsel ID: ' + esc(String(data.offer_ggsel_id)) : ''}</div>
						${data.payment_date ? `<div class="text-xs text-gray-500 mt-1">Ödeme: ${esc(new Date(data.payment_date).toLocaleString('tr-TR'))}</div>` : ''}
					</div>
					<details><summary class="text-xs text-gray-500 cursor-pointer">Tam JSON</summary><div class="gg-pre mt-2">${esc(JSON.stringify(data, null, 2))}</div></details>
				`;
			});
			loadList();
		},

		async renderOffers(el) {
			el.innerHTML = `
				<div class="gg-card mb-3">
					<div class="flex items-center justify-between flex-wrap gap-2 mb-3">
						<h3 class="font-semibold">Ürünlerim</h3>
						<button class="btn btn-primary btn-sm" id="ggReloadOffers">↻</button>
					</div>
					<div id="ggOffersList"><div class="text-gray-500 text-sm">Yükleniyor...</div></div>
				</div>
				<div class="gg-card">
					<h3 class="font-semibold mb-2">Ürün Detay (ID)</h3>
					<div class="flex gap-2 flex-wrap mb-2">
						<input class="gg-input" id="ggOfferId" placeholder="Offer ID" style="flex:1; min-width:180px;">
						<button class="btn btn-primary btn-sm" id="ggLookupOffer">Aç</button>
					</div>
					<div id="ggOfferDetail"></div>
				</div>
			`;

			const loadList = async () => {
				const lst = $('#ggOffersList');
				lst.innerHTML = '<div class="text-gray-500 text-sm">Yükleniyor...</div>';
				const r = await api('/ggsel/offers').catch(e => ({ ok:false, error:e.message }));
				if (!r.ok) {
					lst.innerHTML = `<div class="text-red-400 text-sm">Hata: ${esc(r.error||'?')}</div>`;
					return;
				}
				const items = this._d(r) || [];
				const pag = this._pag(r);
				if (!Array.isArray(items) || !items.length) {
					lst.innerHTML = `<div class="text-gray-500 text-sm">Ürün yok.</div>`;
					return;
				}
				lst.innerHTML = `
					${pag ? `<div class="text-xs text-gray-500 mb-2">Toplam ürün: ${esc(String(pag.total_count || items.length))}</div>` : ''}
					${items.map(p => {
						const pillCls = p.status === 'active' ? 'active' : (p.status === 'paused' ? 'paused' : 'draft');
						return `
						<div class="gg-list-item" style="cursor:pointer;" data-oid="${esc(String(p.id||''))}">
							<div class="flex justify-between items-start gap-2 flex-wrap">
								<div style="flex:1; min-width:200px;">
									<div class="font-semibold text-sm">${esc(p.title || ('Ürün #' + p.id))}</div>
									<div class="text-xs text-gray-500 mt-1">ID: ${esc(String(p.id))}${p.unlimited_quantity ? ' · ∞ stok' : ' · stok: ' + esc(String(p.quantity || 0))}${p.autoselling ? ' · auto-sell' : ''}</div>
									${p.ggsel_product_url ? `<div class="text-xs mt-1"><a href="${esc(p.ggsel_product_url)}" target="_blank" style="color:#3498db;">GGsel'de gör →</a></div>` : ''}
								</div>
								<div class="text-right">
									<div class="text-sm font-bold">${esc(String(p.price))} ${esc(p.currency || 'RUB')}</div>
									<span class="gg-pill ${pillCls}">${esc(p.status || '?')}</span>
								</div>
							</div>
						</div>`;
					}).join('')}
				`;
				$$('#ggOffersList .gg-list-item[data-oid]').forEach(it => it.addEventListener('click', () => {
					$('#ggOfferId').value = it.dataset.oid;
					$('#ggLookupOffer').click();
				}));
			};

			$('#ggReloadOffers').addEventListener('click', loadList);
			$('#ggLookupOffer').addEventListener('click', async () => {
				const id = $('#ggOfferId').value.trim();
				if (!id) return;
				const det = $('#ggOfferDetail');
				det.innerHTML = '<div class="text-gray-500 text-sm">Yükleniyor...</div>';
				const r = await api('/ggsel/offers/' + encodeURIComponent(id)).catch(e => ({ ok:false, error:e.message }));
				const data = this._d(r);
				if (!r.ok || !data) { det.innerHTML = `<div class="text-red-400 text-sm">${esc(r.error||'?')}</div>`; return; }
				det.innerHTML = `
					<div class="font-semibold mb-1">${esc(data.title || '—')}</div>
					<div class="text-xs text-gray-500 mb-2">${esc(String(data.price || 0))} ${esc(data.currency || 'RUB')} · ${esc(data.status || '?')}</div>
					<details><summary class="text-xs text-gray-500 cursor-pointer">Tam JSON</summary><div class="gg-pre mt-2">${esc(JSON.stringify(data, null, 2))}</div></details>
				`;
			});
			loadList();
		},

		async renderChats(el) {
			el.innerHTML = `
				<div class="gg-card mb-3">
					<div class="flex justify-between items-center flex-wrap gap-2 mb-3">
						<h3 class="font-semibold">Mesajlar</h3>
						<button class="btn btn-primary btn-sm" id="ggReloadChats">↻</button>
					</div>
					<div id="ggChatsList"><div class="text-gray-500 text-sm">Yükleniyor...</div></div>
				</div>
				<div id="ggChatThread"></div>
			`;

			const load = async () => {
				const lst = $('#ggChatsList');
				lst.innerHTML = '<div class="text-gray-500 text-sm">Yükleniyor...</div>';
				const r = await api('/ggsel/conversations').catch(e => ({ ok:false, error:e.message }));
				if (!r.ok) { lst.innerHTML = `<div class="text-red-400 text-sm">Hata: ${esc(r.error||'?')}</div>`; return; }
				const items = this._d(r) || [];
				if (!Array.isArray(items) || !items.length) {
					lst.innerHTML = `<div class="text-gray-500 text-sm">Mesaj yok.</div>`;
					return;
				}
				lst.innerHTML = items.map(c => {
					const u = c.user || {};
					const last = c.last_message || {};
					const dateStr = last.created_at || c.updated_at || c.created_at || '';
					const date = dateStr ? new Date(dateStr).toLocaleString('tr-TR') : '';
					const preview = (last.text || last.image_url ? '🖼 [resim]' : '').substring(0, 90);
					return `
					<div class="gg-list-item" style="cursor:pointer;" data-cid="${esc(String(c.id||''))}">
						<div class="flex justify-between items-start gap-2 flex-wrap">
							<div class="flex gap-2" style="flex:1; min-width:200px;">
								${u.avatar_url ? `<img class="gg-avatar" src="${esc(u.avatar_url)}" alt="">` : '<div class="gg-avatar"></div>'}
								<div>
									<div class="font-semibold text-sm">${esc(u.username || 'Müşteri')}${c.system ? ' <span class="gg-pill draft">SYS</span>' : ''}</div>
									<div class="text-xs text-gray-500 mt-1">${esc(preview)}</div>
								</div>
							</div>
							<div class="text-right">
								<div class="text-xs text-gray-500">${esc(date)}</div>
								${c.unread_count ? `<span class="status-pill pill-failed mt-1">${esc(String(c.unread_count))}</span>` : ''}
							</div>
						</div>
					</div>`;
				}).join('');
				$$('#ggChatsList .gg-list-item[data-cid]').forEach(it => it.addEventListener('click', () => this.openThread(it.dataset.cid)));
			};
			$('#ggReloadChats').addEventListener('click', load);
			load();
		},

		async openThread(cid) {
			const wrap = $('#ggChatThread');
			wrap.innerHTML = '<div class="gg-card"><div class="text-gray-500 text-sm">Yükleniyor...</div></div>';
			const r = await api('/ggsel/conversations/' + encodeURIComponent(cid)).catch(e => ({ ok:false, error:e.message }));
			const data = this._d(r);
			if (!r.ok || !data) {
				wrap.innerHTML = `<div class="gg-card text-red-400 text-sm">${esc(r.error||'?')}</div>`;
				return;
			}
			const messages = data.messages || data.message_list || [];
			wrap.innerHTML = `
				<div class="gg-card">
					<div class="flex items-center justify-between mb-2">
						<h3 class="font-semibold">Konuşma #${esc(cid)}</h3>
						<button class="btn btn-secondary btn-sm" id="ggMarkRead">Okundu işaretle</button>
					</div>
					${messages.length ? `
						<div style="max-height:400px; overflow-y:auto;">
							${messages.map(m => `
								<div class="gg-list-item" style="${m.is_current_user ? 'background:#1e2030;' : ''}">
									<div class="text-xs text-gray-500 mb-1">${esc(m.is_current_user ? 'Sen' : 'Müşteri')} · ${esc(m.created_at ? new Date(m.created_at).toLocaleString('tr-TR') : '')}</div>
									<div class="text-sm">${esc(m.text || '')}</div>
									${m.image_url ? `<img src="${esc(m.image_url)}" style="max-width:200px; max-height:200px; border-radius:6px; margin-top:0.5rem;">` : ''}
								</div>
							`).join('')}
						</div>
					` : '<div class="text-xs text-gray-500">Mesaj listesi alınamadı veya boş.</div>'}
					<details class="mt-3"><summary class="text-xs text-gray-500 cursor-pointer">Ham yanıt</summary><div class="gg-pre mt-2">${esc(JSON.stringify(data, null, 2))}</div></details>
				</div>
			`;
			$('#ggMarkRead').addEventListener('click', async () => {
				const r2 = await api('/ggsel/conversations/' + encodeURIComponent(cid) + '/read', { method: 'POST', body: '{}' }).catch(e => ({ ok:false, error:e.message }));
				toast(r2.ok ? 'Okundu' : (r2.error || 'Hata'), r2.ok ? 'success' : 'error');
			});
		},

		async renderAccount(el) {
			const [bal, notif, currs, me] = await Promise.all([
				api('/ggsel/account/balance').catch(e => ({ ok:false, error:e.message })),
				api('/ggsel/account/notifications').catch(e => ({ ok:false, error:e.message })),
				api('/ggsel/account/currencies').catch(e => ({ ok:false, error:e.message })),
				api('/ggsel/users/me').catch(e => ({ ok:false, error:e.message }))
			]);
			const balData = this._d(bal) || {};
			const notifData = this._d(notif) || {};
			const currsData = this._d(currs) || [];
			const meData = this._d(me) || {};

			el.innerHTML = `
				<div class="gg-grid mb-3">
					<div class="gg-stat">
						<div class="label">Bakiye</div>
						<div class="value">${esc(String(balData.amount != null ? Number(balData.amount).toFixed(2) : '—'))} <span style="font-size:0.7rem; color:#6b6b78;">RUB</span></div>
						${balData.amount_in_hold != null ? `<div class="delta">Beklemede: ${esc(Number(balData.amount_in_hold).toFixed(2))}</div>` : ''}
					</div>
					<div class="gg-stat">
						<div class="label">Kullanıcı</div>
						<div class="value" style="font-size:1rem;">${esc(meData.username || '—')}</div>
						<div class="delta">${esc(meData.email || '')}</div>
					</div>
					<div class="gg-stat">
						<div class="label">GGsel ID</div>
						<div class="value" style="font-size:1rem;" class="font-mono">${esc(String(meData.ggsel_id || meData.id || '—'))}</div>
					</div>
				</div>

				<div class="gg-card mb-3">
					<h3 class="font-semibold mb-2">Bildirim Ayarları</h3>
					<div class="text-xs text-gray-500 mb-2">E-posta: ${notifData.email_enabled ? '✓ açık' : '✗ kapalı'}${notifData.telegram_enabled !== undefined ? ' · Telegram: ' + (notifData.telegram_enabled ? '✓ açık' : '✗ kapalı') : ''}</div>
					<details><summary class="text-xs text-gray-500 cursor-pointer">Tam JSON</summary><div class="gg-pre mt-2">${esc(JSON.stringify(notifData, null, 2))}</div></details>
				</div>

				<div class="gg-card">
					<h3 class="font-semibold mb-2">Para Birimleri (${esc(String(Array.isArray(currsData) ? currsData.length : Object.keys(currsData).length))})</h3>
					<details><summary class="text-xs text-gray-500 cursor-pointer">Liste</summary><div class="gg-pre mt-2">${esc(JSON.stringify(currsData, null, 2))}</div></details>
				</div>
			`;
		},

		async renderWallets(el) {
			const r = await api('/ggsel/wallets').catch(e => ({ ok:false, error:e.message }));
			const items = this._d(r) || [];
			el.innerHTML = `
				<div class="gg-card">
					<h3 class="font-semibold mb-2">Çekim Cüzdanlarım</h3>
					${!r.ok ? `<div class="text-red-400 text-sm">Hata: ${esc(r.error||'?')}</div>` : ''}
					${Array.isArray(items) && items.length ? items.map(w => `
						<div class="gg-list-item">
							<div class="flex justify-between items-start gap-2 flex-wrap">
								<div>
									<div class="font-semibold text-sm">${esc(w.name || w.type || w.code || 'Cüzdan')}</div>
									<div class="text-xs text-gray-500 mt-1 font-mono">${esc(w.account || w.address || w.identifier || w.number || '')}</div>
								</div>
								<span class="gg-pill ${w.is_verified || w.verified ? 'active' : 'paused'}">${w.is_verified || w.verified ? 'Doğrulandı' : 'Beklemede'}</span>
							</div>
						</div>
					`).join('') : '<div class="text-gray-500 text-sm">Cüzdan yok. GGsel sitesinden ekleyebilirsin.</div>'}
				</div>
			`;
		},

		async renderCategories(el) {
			const r = await api('/ggsel/categories').catch(e => ({ ok:false, error:e.message }));
			const items = this._d(r) || [];
			el.innerHTML = `
				<div class="gg-card">
					<h3 class="font-semibold mb-2">Kategoriler (${esc(String(Array.isArray(items) ? items.length : 0))})</h3>
					${!r.ok ? `<div class="text-red-400 text-sm">Hata: ${esc(r.error||'?')}</div>` : ''}
					${Array.isArray(items) && items.length ? items.map(c => `
						<div class="gg-list-item">
							<div class="flex justify-between items-start gap-2 flex-wrap">
								<div>
									<div class="font-semibold text-sm">${esc(c.title || c.name || '—')}</div>
									<div class="text-xs text-gray-500 mt-1">ID: ${esc(String(c.id))}${c.kind ? ' · ' + esc(c.kind) : ''}${c.has_children ? ' · alt kategoriler var' : ''}</div>
								</div>
								<div class="text-right">
									<div class="text-xs font-mono">${esc(String(c.fee != null ? (c.fee * 100).toFixed(0) + '%' : '?'))}</div>
									<span class="gg-pill ${c.status === 'active' ? 'active' : 'draft'}">${esc(c.status || '?')}</span>
								</div>
							</div>
						</div>
					`).join('') : '<div class="text-gray-500 text-sm">Kategori yok.</div>'}
				</div>
			`;
		},

		async renderApiKeys(el) {
			el.innerHTML = `
				<div class="gg-card mb-3">
					<div class="flex justify-between items-center flex-wrap gap-2 mb-3">
						<h3 class="font-semibold">API Anahtarları</h3>
						<button class="btn btn-primary btn-sm" id="ggApiKeyNew">+ Yeni Key</button>
					</div>
					<div id="ggApiKeyList"><div class="text-gray-500 text-sm">Yükleniyor...</div></div>
				</div>
			`;
			const load = async () => {
				const lst = $('#ggApiKeyList');
				lst.innerHTML = '<div class="text-gray-500 text-sm">Yükleniyor...</div>';
				const r = await api('/ggsel/api-keys').catch(e => ({ ok:false, error:e.message }));
				if (!r.ok) { lst.innerHTML = `<div class="text-red-400 text-sm">Hata: ${esc(r.error||'?')}</div>`; return; }
				const items = this._d(r) || [];
				if (!Array.isArray(items) || !items.length) { lst.innerHTML = `<div class="text-gray-500 text-sm">API key yok.</div>`; return; }
				lst.innerHTML = items.map(k => `
					<div class="gg-list-item">
						<div class="flex justify-between items-start gap-2 flex-wrap">
							<div style="flex:1; min-width:200px;">
								<div class="font-semibold text-sm">${esc(k.title || k.name || ('Key #' + k.id))}</div>
								<div class="text-xs text-gray-500 mt-1 font-mono">${esc((k.token || '').substring(0, 30))}...</div>
								${k.comment ? `<div class="text-xs text-gray-500 mt-1">${esc(k.comment)}</div>` : ''}
								${k.permissions ? `<div class="text-xs text-gray-600 mt-1">İzinler: ${esc(JSON.stringify(k.permissions).substring(0, 100))}</div>` : ''}
							</div>
							<div class="flex flex-col gap-1 text-right">
								<span class="gg-pill ${k.status === 'active' ? 'active' : 'draft'}">${esc(k.status || '?')}</span>
								<button class="btn btn-danger btn-sm" data-revoke="${esc(String(k.id||''))}">İptal</button>
							</div>
						</div>
					</div>
				`).join('');
				$$('#ggApiKeyList [data-revoke]').forEach(b => b.addEventListener('click', async () => {
					if (!confirmAction('API key iptal edilsin mi?')) return;
					const r2 = await api('/ggsel/api-keys/' + encodeURIComponent(b.dataset.revoke) + '/revoke', { method: 'POST', body: '{}' }).catch(e => ({ ok:false, error:e.message }));
					toast(r2.ok ? 'İptal edildi' : 'Hata: ' + (r2.error||'?'), r2.ok ? 'success' : 'error');
					if (r2.ok) load();
				}));
			};
			$('#ggApiKeyNew').addEventListener('click', () => {
				openModal(`
					<div class="p-6">
						<h3 class="text-xl font-bold mb-3">Yeni API Key</h3>
						<label class="text-xs text-gray-500 mb-1 block">Başlık</label>
						<input class="gg-input mb-3" id="newKeyName" placeholder="örn: cscommends-integration">
						<label class="text-xs text-gray-500 mb-1 block">Yorum (opsiyonel)</label>
						<input class="gg-input mb-3" id="newKeyDesc" placeholder="">
						<div class="flex justify-end gap-2">
							<button class="btn btn-secondary btn-sm" onclick="closeModal()">İptal</button>
							<button class="btn btn-primary btn-sm" id="newKeyCreateBtn">Oluştur</button>
						</div>
						<div id="newKeyResult" class="mt-3"></div>
					</div>
				`);
				$('#newKeyCreateBtn').addEventListener('click', async () => {
					const title = $('#newKeyName').value.trim();
					if (!title) return;
					const r = await api('/ggsel/api-keys', { method: 'POST', body: JSON.stringify({ title, comment: $('#newKeyDesc').value.trim() }) }).catch(e => ({ ok:false, error:e.message }));
					$('#newKeyResult').innerHTML = `<div class="${r.ok?'text-green-400':'text-red-400'} text-sm mb-2">${r.ok?'✓ Oluşturuldu':'✗ '+esc(r.error||'?')}</div><div class="gg-pre">${esc(JSON.stringify(r, null, 2))}</div>`;
					if (r.ok) load();
				});
			});
			load();
		},

		async renderSettings(el) {
			const s = this.state.settings || {};
			el.innerHTML = `
				<div class="gg-card mb-3">
					<h3 class="font-semibold mb-2">GGsel Hesabı ile Giriş</h3>
					<p class="text-xs text-gray-500 mb-3">GGsel marketplace seller hesabının e-posta + şifresi ile giriş yap. Çerez tabanlı oturum kullanır.</p>
					<label class="text-xs text-gray-500 mb-1 block">E-posta</label>
					<input class="gg-input" id="ggLoginEmail" value="${esc(s.email || '')}" placeholder="example@email.com" autocomplete="username" type="email">
					<label class="text-xs text-gray-500 mb-1 block mt-3">Şifre</label>
					<input class="gg-input" id="ggLoginPass" type="password" placeholder="••••••••" autocomplete="current-password">
					<button class="btn btn-primary btn-sm mt-3" id="ggLoginBtn">Giriş Yap</button>
					<div id="ggLoginResult" class="mt-3"></div>
				</div>

				<div class="gg-card mb-3">
					<h3 class="font-semibold mb-2">📡 Generic API Probe</h3>
					<p class="text-xs text-gray-500 mb-2">Ham endpoint test. Path <code>/api/v1</code> base'inden sonraki kısım. Örn: <code>/users/me</code></p>
					<div class="gg-grid mb-2">
						<select class="gg-select" id="ggProxyMethod">
							<option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option>
						</select>
						<input class="gg-input" id="ggProxyEndpoint" placeholder="/users/me">
					</div>
					<textarea class="gg-input" id="ggProxyBody" rows="3" placeholder="Body (JSON, opsiyonel)"></textarea>
					<button class="btn btn-primary btn-sm mt-2" id="ggProxyBtn">Çağır</button>
					<div id="ggProxyResult" class="mt-3"></div>
				</div>

				<div class="gg-card">
					<h3 class="font-semibold mb-2">Bağlantı Bilgisi</h3>
					<div class="text-xs text-gray-500"><strong>Base URL:</strong> ${esc(s.baseUrl || 'https://seller.ggsel.com/api/v1')}</div>
					<div class="text-xs text-gray-500 mt-1"><strong>E-posta:</strong> ${esc(s.email || '—')}</div>
					<div class="text-xs text-gray-500 mt-1"><strong>Token preview:</strong> <span class="font-mono">${esc(s.tokenPreview || '—')}</span></div>
					<div class="text-xs text-gray-500 mt-1"><strong>Token bitiş:</strong> ${s.expiresAt ? new Date(s.expiresAt).toLocaleString('tr-TR') : '—'}</div>
					<div class="text-xs text-gray-500 mt-1"><strong>Bağlı:</strong> ${s.hasToken ? '✓ Evet' : '✗ Hayır'}</div>
				</div>
			`;

			$('#ggLoginBtn').addEventListener('click', async () => {
				const email = $('#ggLoginEmail').value.trim();
				const password = $('#ggLoginPass').value;
				const result = $('#ggLoginResult');
				if (!email || !password) { result.innerHTML = '<div class="text-red-400 text-sm">E-posta + şifre gerekli</div>'; return; }
				result.innerHTML = '<div class="text-gray-500 text-sm">Giriş yapılıyor...</div>';
				const r = await api('/ggsel/login', { method: 'POST', body: JSON.stringify({ email, password }) }).catch(e => ({ ok:false, error:e.message }));
				if (r.ok) {
					result.innerHTML = '<div class="text-green-400 text-sm">✓ Giriş başarılı! Cookies alındı.</div>';
					setTimeout(() => this.load(), 800);
				} else {
					result.innerHTML = `<div class="text-red-400 text-sm">✗ ${esc(r.error || 'login_failed')}</div><div class="gg-pre mt-2">${esc(JSON.stringify(r, null, 2))}</div>`;
				}
			});

			$('#ggProxyBtn').addEventListener('click', async () => {
				const method = $('#ggProxyMethod').value;
				const endpoint = $('#ggProxyEndpoint').value.trim();
				const bodyText = $('#ggProxyBody').value.trim();
				let body = null;
				if (bodyText) {
					try { body = JSON.parse(bodyText); } catch(e) { $('#ggProxyResult').innerHTML = `<div class="text-red-400 text-sm">JSON hata: ${esc(e.message)}</div>`; return; }
				}
				const result = $('#ggProxyResult');
				result.innerHTML = '<div class="text-gray-500 text-sm">Çağrılıyor...</div>';
				const r = await api('/ggsel/proxy', { method: 'POST', body: JSON.stringify({ method, endpoint, body }) }).catch(e => ({ ok:false, error:e.message }));
				result.innerHTML = `<div class="${r.ok?'text-green-400':'text-red-400'} text-sm mb-2">HTTP ${r.status||'?'} ${r.ok?'✓':'✗ '+esc(r.error||'')}</div><div class="gg-pre">${esc(JSON.stringify(r.data || r, null, 2))}</div>`;
			});
		},

		async testConnection() {
			const r = await api('/ggsel/test-connection', { method: 'POST', body: '{}' }).catch(e => ({ ok:false, error:e.message }));
			const data = this._d(r);
			toast(r.ok ? `✓ ${(data && data.email) || (data && data.username) || 'Bağlandı'}` : `✗ ${r.error || '?'}`, r.ok ? 'success' : 'error');
		},

		async doLogout() {
			if (!confirmAction('GGsel hesabından çıkış yapılsın mı?')) return;
			await api('/ggsel/logout', { method: 'POST', body: '{}' }).catch(()=>null);
			toast('Çıkış yapıldı', 'success');
			this.load();
		}
	};

	sections.reviews = {
		state: { filter: 'pending', productType: '', minRating: '', limit: 50, offset: 0, lastTotal: 0, lastStats: null },

		async load() {
			const params = new URLSearchParams({
				status: this.state.filter || '',
				productType: this.state.productType || '',
				minRating: this.state.minRating || '',
				limit: this.state.limit,
				offset: this.state.offset
			});
			['status','productType','minRating'].forEach(k => { if (!params.get(k)) params.delete(k); });
			const data = await api('/reviews?' + params.toString());
			this.state.lastTotal = data.total;
			this.state.lastStats = data.stats;
			this.render(data);
			this.refreshBadge();
		},

		async refreshBadge() {
			try {
				const d = await api('/reviews?status=pending&limit=1');
				const badge = document.getElementById('reviewsPendingBadge');
				if (!badge) return;
				const n = (d.stats && d.stats.pending) || 0;
				if (n > 0) {
					badge.textContent = n > 99 ? '99+' : n;
					badge.classList.remove('hidden');
				} else {
					badge.classList.add('hidden');
				}
			} catch {}
		},

		render(d) {
			const stats = d.stats || {};
			const stars = (n) => '★★★★★☆☆☆☆☆'.slice(5 - n, 10 - n);
			const productPill = (p) => {
				const m = { commend: 'Commend', hours: 'Hours', group: 'Grup', free: 'Ücretsiz' };
				return `<span class="status-pill pill-${p === 'commend' ? 'completed' : 'pending'}">${esc(m[p] || p)}</span>`;
			};
			const statusPill = (s) => {
				const cls = s === 'approved' ? 'pill-completed' : (s === 'rejected' ? 'pill-failed' : 'pill-pending');
				const label = s === 'approved' ? 'Onaylandı' : (s === 'rejected' ? 'Reddedildi' : 'Beklemede');
				return `<span class="status-pill ${cls}">${label}</span>`;
			};

			const rows = (d.reviews || []).map(r => {
				const txLink = r.transaction_id
					? `<a href="#" onclick="adminActions.viewTransaction(${r.transaction_id});return false;" class="text-blue-400 hover:underline">Tx #${r.transaction_id}</a>`
					: r.free_commend_id ? `<span class="text-green-400">Ücretsiz #${r.free_commend_id}</span>` : '—';
				const profileLink = r.steam_id
					? `<a href="https://steamcommunity.com/profiles/${esc(r.steam_id)}" target="_blank" rel="noopener" class="text-blue-400 text-xs hover:underline">${esc(r.steam_id.substring(0, 12))}…</a>`
					: '—';
				return `
				<tr class="${r.status === 'pending' ? 'bg-yellow-500/5' : ''}">
					<td class="text-yellow-400 text-base font-bold whitespace-nowrap">${stars(r.rating)} <span class="text-xs text-gray-500">(${r.rating}/5)</span></td>
					<td class="max-w-md">
						<div class="text-sm">${r.comment ? esc(r.comment) : '<span class="text-gray-500 italic">— yorum yok —</span>'}</div>
						${r.admin_note ? `<div class="text-xs text-gray-500 mt-1">📝 ${esc(r.admin_note)}</div>` : ''}
					</td>
					<td class="text-xs">
						<div class="text-gray-300">${esc(r.display_name || 'Anonim')}</div>
						<div>${profileLink}</div>
					</td>
					<td>${productPill(r.product_type)}</td>
					<td class="text-xs">${txLink}</td>
					<td>${statusPill(r.status)}</td>
					<td class="text-xs text-gray-500 whitespace-nowrap">${new Date(r.created_at).toLocaleString('tr-TR')}</td>
					<td class="text-right whitespace-nowrap">
						${r.status !== 'approved' ? `<button class="btn btn-success btn-sm" onclick="adminActions.reviewApprove(${r.id})">Onayla</button>` : ''}
						${r.status !== 'rejected' ? `<button class="btn btn-secondary btn-sm" onclick="adminActions.reviewReject(${r.id})">Reddet</button>` : ''}
						${r.status === 'approved' ? `<button class="btn btn-secondary btn-sm" onclick="adminActions.reviewToggleFeatured(${r.id}, ${r.is_featured})">${r.is_featured ? '★ Pin Kaldır' : '☆ Pin'}</button>` : ''}
						<button class="btn btn-danger btn-sm" onclick="adminActions.reviewDelete(${r.id})">Sil</button>
					</td>
				</tr>`;
			}).join('');

			const totalPages = Math.max(1, Math.ceil((d.total || 0) / this.state.limit));
			const currentPage = Math.floor(this.state.offset / this.state.limit) + 1;

			$('#sectionRoot').innerHTML = `
				<div class="mb-4">
					<h1 class="text-2xl font-bold mb-1">⭐ Müşteri Yorumları</h1>
					<p class="text-sm text-gray-500">Onaylanan yorumlar ana sayfada yayınlanır.</p>
				</div>

				<div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
					<div class="card p-3"><div class="text-xs text-gray-500">Beklemede</div><div class="text-2xl font-bold text-yellow-400">${stats.pending || 0}</div></div>
					<div class="card p-3"><div class="text-xs text-gray-500">Onaylı</div><div class="text-2xl font-bold text-green-400">${stats.approved || 0}</div></div>
					<div class="card p-3"><div class="text-xs text-gray-500">Reddedildi</div><div class="text-2xl font-bold text-gray-400">${stats.rejected || 0}</div></div>
					<div class="card p-3"><div class="text-xs text-gray-500">Toplam</div><div class="text-2xl font-bold">${stats.total || 0}</div></div>
					<div class="card p-3"><div class="text-xs text-gray-500">Ortalama (Onaylı)</div><div class="text-2xl font-bold text-yellow-400">★ ${stats.avgApproved ? stats.avgApproved.toFixed(2) : '—'}</div></div>
				</div>

				<div class="card mb-3">
					<div class="flex flex-wrap gap-2 items-center">
						<select id="rvFilterStatus" class="input input-sm">
							<option value="pending"${this.state.filter === 'pending' ? ' selected' : ''}>Beklemede</option>
							<option value="approved"${this.state.filter === 'approved' ? ' selected' : ''}>Onaylı</option>
							<option value="rejected"${this.state.filter === 'rejected' ? ' selected' : ''}>Reddedildi</option>
							<option value=""${this.state.filter === '' ? ' selected' : ''}>Tümü</option>
						</select>
						<select id="rvFilterProduct" class="input input-sm">
							<option value=""${!this.state.productType ? ' selected' : ''}>Tüm ürünler</option>
							<option value="commend"${this.state.productType === 'commend' ? ' selected' : ''}>Commend</option>
							<option value="hours"${this.state.productType === 'hours' ? ' selected' : ''}>Hours</option>
							<option value="group"${this.state.productType === 'group' ? ' selected' : ''}>Grup</option>
							<option value="free"${this.state.productType === 'free' ? ' selected' : ''}>Ücretsiz</option>
						</select>
						<select id="rvFilterMin" class="input input-sm">
							<option value=""${!this.state.minRating ? ' selected' : ''}>Min. puan</option>
							<option value="5"${this.state.minRating === '5' ? ' selected' : ''}>5★</option>
							<option value="4"${this.state.minRating === '4' ? ' selected' : ''}>4★+</option>
							<option value="3"${this.state.minRating === '3' ? ' selected' : ''}>3★+</option>
							<option value="2"${this.state.minRating === '2' ? ' selected' : ''}>2★+</option>
							<option value="1"${this.state.minRating === '1' ? ' selected' : ''}>1★+</option>
						</select>
						<button class="btn btn-secondary btn-sm" onclick="sections.reviews.load()">↻ Yenile</button>
					</div>
				</div>

				<div class="card overflow-x-auto">
					<table class="table">
						<thead>
							<tr>
								<th>Puan</th>
								<th>Yorum</th>
								<th>Kullanıcı</th>
								<th>Ürün</th>
								<th>Kaynak</th>
								<th>Durum</th>
								<th>Tarih</th>
								<th></th>
							</tr>
						</thead>
						<tbody>
							${rows || '<tr><td colspan="8" class="text-center text-gray-500 py-6">Bu filtrede yorum yok</td></tr>'}
						</tbody>
					</table>
				</div>

				<div class="cluster cluster-between mt-3">
					<div class="text-xs text-gray-500">Toplam: ${d.total || 0} · Sayfa ${currentPage}/${totalPages}</div>
					<div class="cluster">
						<button class="btn btn-secondary btn-sm" onclick="sections.reviews.prev()" ${this.state.offset === 0 ? 'disabled' : ''}>← Önceki</button>
						<button class="btn btn-secondary btn-sm" onclick="sections.reviews.next()" ${this.state.offset + this.state.limit >= (d.total || 0) ? 'disabled' : ''}>Sonraki →</button>
					</div>
				</div>
			`;

			const onChange = () => {
				this.state.filter = $('#rvFilterStatus').value;
				this.state.productType = $('#rvFilterProduct').value;
				this.state.minRating = $('#rvFilterMin').value;
				this.state.offset = 0;
				this.load();
			};
			['#rvFilterStatus','#rvFilterProduct','#rvFilterMin'].forEach(id => $(id).addEventListener('change', onChange));
		},

		next() { this.state.offset += this.state.limit; this.load(); },
		prev() { this.state.offset = Math.max(0, this.state.offset - this.state.limit); this.load(); },

		async approve(id) {
			try {
				await api('/reviews/' + id + '/approve', { method: 'POST', body: '{}' });
				toast('Yorum onaylandı', 'success');
				this.load();
			} catch (e) { toast('Hata: ' + e.message, 'error'); }
		},

		async reject(id) {
			const note = prompt('Reddetme nedeni (opsiyonel):') || null;
			try {
				await api('/reviews/' + id + '/reject', { method: 'POST', body: JSON.stringify({ note }) });
				toast('Yorum reddedildi', 'success');
				this.load();
			} catch (e) { toast('Hata: ' + e.message, 'error'); }
		},

		async toggleFeatured(id, currentlyFeatured) {
			const featured = currentlyFeatured ? 0 : 1;
			try {
				await api('/reviews/' + id + '/feature', { method: 'POST', body: JSON.stringify({ featured }) });
				toast(featured ? 'Ana sayfaya pin\'lendi' : 'Pin kaldırıldı', 'success');
				this.load();
			} catch (e) { toast('Hata: ' + e.message, 'error'); }
		},

		async deleteOne(id) {
			if (!confirmAction('Yorum kalıcı olarak silinsin mi?')) return;
			try {
				await api('/reviews/' + id, { method: 'DELETE' });
				toast('Yorum silindi', 'success');
				this.load();
			} catch (e) { toast('Hata: ' + e.message, 'error'); }
		}
	};

	sections.promos = {
		async load() {
			const data = await api('/promos');
			this.render(data);
		},
		render(d) {
			const rows = (d.promos || []).map(p => `
				<tr>
					<td class="font-mono text-xs">${esc(p.code)}</td>
					<td>${fmtBalance(p.balance)}</td>
					<td>${p.currentUses || 0}/${p.maxUses || '∞'}</td>
					<td class="text-xs">${esc(p.communityName || '—')}</td>
					<td class="text-xs">${p.expiresAt ? fmtDate(p.expiresAt) : 'Süresiz'}</td>
					<td>${p.isActive ? '<span class="status-pill pill-online">Aktif</span>' : '<span class="status-pill pill-offline">Pasif</span>'}</td>
					<td class="text-right whitespace-nowrap">
						<button class="btn btn-secondary btn-sm" onclick="adminActions.promosRedemptions(${p.id})">Kullanım</button>
						<button class="btn btn-secondary btn-sm" onclick="adminActions.promosToggle(${p.id}, ${p.isActive ? 'true' : 'false'})">${p.isActive ? 'Pasifleştir' : 'Aktifleştir'}</button>
						<button class="btn btn-danger btn-sm" onclick="adminActions.promosDelete(${p.id})">Sil</button>
					</td>
				</tr>
			`).join('');
			$('#sectionRoot').innerHTML = `
				<div class="mb-5 flex items-center justify-between">
					<h1 class="text-2xl font-bold">Promosyon Kodları <span class="text-sm text-gray-500 font-normal">(${fmtNum(d.total || 0)})</span></h1>
					<button onclick="adminActions.promosNew()" class="btn btn-primary btn-sm">+ Yeni Promosyon</button>
				</div>
				<div class="card overflow-x-auto">
					<table class="table">
						<thead><tr><th>Kod</th><th>Bakiye</th><th>Kullanım</th><th>Topluluk</th><th>Son Tarih</th><th>Durum</th><th></th></tr></thead>
						<tbody>${rows || '<tr><td colspan="7" class="text-center text-gray-500 py-6">Promosyon yok</td></tr>'}</tbody>
					</table>
				</div>
			`;
		},
		async deleteOne(id) {
			if (!confirmAction('Promosyon silinsin mi?')) return;
			try { await api('/promos/' + id, { method: 'DELETE' }); toast('Silindi', 'success'); this.load(); }
			catch (e) { toast(e.message, 'error'); }
		},
		async toggle(id, currentActive) {
			try {
				await api('/promos/' + id, { method: 'PATCH', body: JSON.stringify({ isActive: !currentActive }) });
				toast('Güncellendi', 'success'); this.load();
			} catch (e) { toast(e.message, 'error'); }
		},
		newModal() {
			openModal(`
				<div class="p-6">
					<h2 class="text-xl font-bold mb-4">Yeni Promosyon Kodu</h2>
					<div class="grid grid-cols-2 gap-3">
						<div><label class="label">Adet (1-100)</label><input id="prCount" type="number" class="input" value="1" min="1" max="100"></div>
						<div><label class="label">Bakiye</label><input id="prBalance" type="number" class="input" value="10" min="1"></div>
						<div><label class="label">Maks Kullanım</label><input id="prMax" type="number" class="input" value="1" min="1"></div>
						<div><label class="label">Önek</label><input id="prPrefix" class="input" placeholder="PROMO"></div>
						<div class="col-span-2"><label class="label">Topluluk Adı (opsiyonel)</label><input id="prComm" class="input"></div>
						<div class="col-span-2"><label class="label">Son Tarih (opsiyonel)</label><input id="prExp" type="datetime-local" class="input"></div>
					</div>
					<div id="prResult" class="my-3"></div>
					<div class="flex justify-end gap-2"><button onclick="closeModal()" class="btn btn-secondary btn-sm">Kapat</button><button onclick="adminActions.promosCreate()" class="btn btn-primary btn-sm">Oluştur</button></div>
				</div>
			`);
		},
		async createSubmit() {
			try {
				const body = {
					count: parseInt($('#prCount').value),
					balance: parseInt($('#prBalance').value),
					maxUses: parseInt($('#prMax').value),
					prefix: $('#prPrefix').value.trim() || undefined,
					communityName: $('#prComm').value.trim() || undefined,
					expiresAt: $('#prExp').value || undefined
				};
				const r = await api('/promos/generate', { method: 'POST', body: JSON.stringify(body) });
				const list = (r.codes || []).map(c => c.code).join('\n');
				$('#prResult').innerHTML = `<div class="bg-[#0c0c11] rounded p-3 text-xs font-mono max-h-40 overflow-y-auto whitespace-pre">${esc(list)}</div>`;
				toast(`${r.generated || 0} kod üretildi`, 'success');
				this.load();
			} catch (e) { toast(e.message, 'error'); }
		},
		async viewRedemptions(id) {
			try {
				const d = await api(`/promos/${id}/redemptions`);
				const rows = (d.redemptions || []).map(r => `<tr><td class="text-xs">${esc(r.steam_name || '—')}</td><td class="font-mono text-xs">${esc(r.steam_id || '')}</td><td class="text-xs">${fmtDate(r.redeemed_at)}</td></tr>`).join('');
				openModal(`<div class="p-6"><div class="flex justify-between mb-4"><h2 class="text-xl font-bold">Kullanımlar (${(d.redemptions||[]).length})</h2><button onclick="closeModal()" class="text-gray-500">✕</button></div><table class="table"><thead><tr><th>Kullanıcı</th><th>Steam ID</th><th>Zaman</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="text-center text-gray-500 py-4">Kullanım yok</td></tr>'}</tbody></table></div>`);
			} catch (e) { toast(e.message, 'error'); }
		}
	};

	sections.server = {
		async load() {
			const [srv, pr] = await Promise.all([api('/server'), api('/proxies')]);
			this.render(srv, pr);
		},
		render(srv, pr) {
			const proxies = (pr.proxies || []).map((p, i) => `
				<tr><td class="font-mono text-xs">${esc(p)}</td><td class="text-right"><button class="btn btn-danger btn-sm" onclick="adminActions.serverProxyDelete(${i})">Sil</button></td></tr>
			`).join('');
			const connected = Array.isArray(srv.connectedPlayers) ? srv.connectedPlayers : [];
			$('#sectionRoot').innerHTML = `
				<h1 class="text-2xl font-bold mb-5">Sunucu & Proxy</h1>
				<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
					<div class="card">
						<h3 class="font-semibold mb-3">CS2 Sunucu</h3>
						<div class="grid grid-cols-2 gap-3 mb-3">
							<div><label class="label">IP</label><input id="srvIp" class="input" value="${esc(srv.ip || '')}"></div>
							<div><label class="label">Port</label><input id="srvPort" type="number" class="input" value="${srv.port || 27015}"></div>
							<div><label class="label">RCON IP</label><input id="srvRconIp" class="input" value="${esc(srv.rconIp || '')}" placeholder="varsayılan: IP ile aynı"></div>
							<div><label class="label">RCON Şifresi (boş: değiştirme)</label><input id="srvPass" type="password" class="input" placeholder="••••••"></div>
						</div>
						<div class="text-xs text-gray-500 mb-3">Log Receiver: ${esc(srv.logReceiverIp || '—')}:${srv.logReceiverPort || '?'} · ${srv.logListenerReady ? '<span class="text-green-400">dinleniyor</span>' : '<span class="text-yellow-400">bekliyor</span>'}</div>
						<div class="text-xs text-gray-500 mb-3">Sunucuda ${connected.length} oyuncu</div>
						<div class="flex gap-2">
							<button onclick="adminActions.serverSave()" class="btn btn-primary btn-sm">Kaydet</button>
							<button onclick="adminActions.serverRconTest()" class="btn btn-secondary btn-sm">RCON Test</button>
						</div>
					</div>
					<div class="card">
						<h3 class="font-semibold mb-3">Araçlar</h3>
						<div class="mb-3">
							<label class="label">Oyuncu Kontrolü (Steam ID)</label>
							<div class="flex gap-2"><input id="plSid" class="input" placeholder="76561198..."><button onclick="adminActions.serverCheckPlayer()" class="btn btn-primary btn-sm">Kontrol</button></div>
							<div id="plResult" class="mt-2 text-sm"></div>
						</div>
						<div class="mb-3">
							<label class="label">Övgü Sayısı (Steam ID)</label>
							<div class="flex gap-2"><input id="ccSid" class="input" placeholder="76561198..."><button onclick="adminActions.serverCommendCount()" class="btn btn-primary btn-sm">Sorgula</button></div>
							<div id="ccResult" class="mt-2 text-sm"></div>
						</div>
						<div>
							<label class="label">RCON Komutu</label>
							<div class="flex gap-2"><input id="rconCmd" class="input" placeholder="status"><button onclick="adminActions.serverRconExec()" class="btn btn-primary btn-sm">Çalıştır</button></div>
							<pre id="rconOut" class="mt-2 bg-[#0c0c11] rounded p-3 text-xs text-green-400 max-h-48 overflow-y-auto whitespace-pre-wrap"></pre>
						</div>
					</div>
					<div class="card lg:col-span-2">
						<div class="flex items-center justify-between mb-3 flex-wrap gap-2">
							<h3 class="font-semibold">Proxy'ler (${(pr.proxies || []).length})</h3>
							<div class="flex gap-2 items-end flex-wrap">
								<select id="pxMode" class="select w-40"><option value="round-robin" ${pr.mode==='round-robin'?'selected':''}>Round-Robin</option><option value="random" ${pr.mode==='random'?'selected':''}>Random</option><option value="sticky" ${pr.mode==='sticky'?'selected':''}>Sticky</option></select>
								<input id="pxSwitch" type="number" class="input w-24" value="${pr.switchEvery || 1}" title="Kaç işlem sonra değişsin">
								<button onclick="adminActions.serverProxySaveSettings()" class="btn btn-secondary btn-sm">Ayarları Kaydet</button>
							</div>
						</div>
						<div class="flex gap-2 mb-3">
							<input id="pxNew" class="input flex-1" placeholder="http://user:pass@host:port veya host:port">
							<button onclick="adminActions.serverProxyAdd()" class="btn btn-primary btn-sm">Ekle</button>
						</div>
						<div class="overflow-x-auto"><table class="table"><tbody>${proxies || '<tr><td class="text-center text-gray-500 py-4">Proxy yok</td></tr>'}</tbody></table></div>
					</div>
				</div>
			`;
		},
		async save() {
			try {
				const body = {
					ip: $('#srvIp').value.trim(),
					port: parseInt($('#srvPort').value),
					rconIp: $('#srvRconIp').value.trim() || undefined
				};
				if ($('#srvPass').value) body.password = $('#srvPass').value;
				await api('/server', { method: 'PATCH', body: JSON.stringify(body) });
				toast('Kaydedildi', 'success');
			} catch (e) { toast(e.message, 'error'); }
		},
		async rconTest() {
			try {
				const r = await api('/server/rcon-test', { method: 'POST' });
				toast(r.success ? 'RCON çalışıyor' : ('Hata: ' + (r.error || '')), r.success ? 'success' : 'error');
			} catch (e) { toast(e.message, 'error'); }
		},
		async checkPlayer() {
			const sid = $('#plSid').value.trim();
			if (!sid) return;
			$('#plResult').innerHTML = '<span class="text-gray-500">Sorgulanıyor...</span>';
			try {
				const r = await api('/server/player-check/' + encodeURIComponent(sid));
				$('#plResult').innerHTML = r.onServer
					? `<span class="text-green-400">✓ Sunucuda</span>`
					: `<span class="text-gray-400">✗ Sunucuda değil</span>`;
			} catch (e) { $('#plResult').innerHTML = `<span class="text-red-400">Hata: ${esc(e.message)}</span>`; }
		},
		async commendCount() {
			const sid = $('#ccSid').value.trim();
			if (!sid) return;
			$('#ccResult').innerHTML = '<span class="text-gray-500">Sorgulanıyor...</span>';
			try {
				const r = await api('/commend-count/' + encodeURIComponent(sid));
				$('#ccResult').innerHTML = `<span class="text-green-400">Dost: <b>${r.friendly ?? '?'}</b></span> · <span class="text-blue-400">Öğretici: <b>${r.teaching ?? '?'}</b></span> · <span class="text-yellow-400">Lider: <b>${r.leader ?? '?'}</b></span>`;
			} catch (e) { $('#ccResult').innerHTML = `<span class="text-red-400">Hata: ${esc(e.message)}</span>`; }
		},
		async rconExec() {
			const cmd = $('#rconCmd').value.trim();
			if (!cmd) return;
			$('#rconOut').textContent = 'Çalıştırılıyor...';
			try {
				const r = await api('/server/rcon-exec', { method: 'POST', body: JSON.stringify({ command: cmd }) });
				$('#rconOut').textContent = r.reply || '(boş yanıt)';
			} catch (e) { $('#rconOut').textContent = 'HATA: ' + e.message; }
		},
		async proxyAdd() {
			const proxy = $('#pxNew').value.trim();
			if (!proxy) return;
			try { await api('/proxies', { method: 'POST', body: JSON.stringify({ proxy }) }); toast('Eklendi', 'success'); this.load(); }
			catch (e) { toast(e.message, 'error'); }
		},
		async proxySaveSettings() {
			try {
				await api('/proxies/settings', { method: 'PATCH', body: JSON.stringify({
					mode: $('#pxMode').value, switchEvery: parseInt($('#pxSwitch').value)
				}) });
				toast('Kaydedildi', 'success');
			} catch (e) { toast(e.message, 'error'); }
		},
		async proxyDelete(index) {
			if (!confirmAction('Proxy silinsin mi?')) return;
			try { await api('/proxies/' + index, { method: 'DELETE' }); toast('Silindi', 'success'); this.load(); }
			catch (e) { toast(e.message, 'error'); }
		}
	};

	sections.analytics = {
		async load() {
			const data = await api('/analytics');
			this.render(data);
		},
		render(d) {
			const daily = d.dailyTransactions || [];
			const hourly = d.hourlyTransactions || [];
			const types = d.commendTypes || {};
			const errs = d.errorBreakdown || [];
			const topUsers = d.topUsers || [];
			const ver = d.verification || {};
			const maxDaily = Math.max(1, ...daily.map(x => x.count || 0));
			const maxHourly = Math.max(1, ...hourly.map(x => x.count || 0));

			const dailyBars = daily.map(x => `
				<div class="chart-bar-wrap flex-1 flex flex-col items-center justify-end h-32">
					<div class="chart-tooltip">${esc(x.date)} · ${x.count} işlem · ${x.commends} övgü</div>
					<div class="w-full bg-[#c0392b] rounded-t" style="height: ${(x.count / maxDaily * 100).toFixed(0)}%; min-height: 2px;"></div>
					<div class="text-[9px] text-gray-500 mt-1">${(x.date || '').slice(5)}</div>
				</div>
			`).join('');

			const hourMap = {};
			hourly.forEach(h => { hourMap[h.hour] = h.count; });
			const hourlyBars = Array.from({ length: 24 }, (_, h) => {
				const c = hourMap[h] || 0;
				return `
					<div class="chart-bar-wrap flex-1 flex flex-col items-center justify-end h-24">
						<div class="chart-tooltip">${h}:00 · ${c} işlem</div>
						<div class="w-full bg-blue-500 rounded-t" style="height: ${(c / maxHourly * 100).toFixed(0)}%; min-height: 2px;"></div>
						${h % 3 === 0 ? `<div class="text-[9px] text-gray-500 mt-1">${h}</div>` : ''}
					</div>
				`;
			}).join('');

			const typeTotal = (types.friendly || 0) + (types.teaching || 0) + (types.leader || 0) || 1;
			const typeRows = [
				{ key: 'friendly', label: 'Dost', color: '#4ade80' },
				{ key: 'teaching', label: 'Öğretici', color: '#60a5fa' },
				{ key: 'leader', label: 'Lider', color: '#facc15' }
			].map(t => {
				const v = types[t.key] || 0, pct = (v / typeTotal * 100).toFixed(1);
				return `<div>
					<div class="flex justify-between text-xs mb-1"><span>${t.label}</span><span>${fmtNum(v)} (${pct}%)</span></div>
					<div class="bg-[#0c0c11] rounded h-3"><div class="h-3 rounded" style="width:${pct}%;background:${t.color}"></div></div>
				</div>`;
			}).join('');

			const errRows = errs.slice(0, 15).map(e => `<tr><td class="text-xs">${esc(e.error_type || 'unknown')}</td><td>${fmtNum(e.count)}</td></tr>`).join('');
			const topRows = topUsers.slice(0, 10).map(u => `
				<tr>
					<td>${esc(u.steam_name || '—')}</td>
					<td class="font-mono text-xs">${esc(u.steam_id || '')}</td>
					<td>${fmtNum(u.txCount)}</td>
					<td>${fmtNum(u.commends)}</td>
				</tr>
			`).join('');

			const verRate = ver.totalProgress > 0 ? ((ver.totalDelivered / ver.totalProgress) * 100).toFixed(1) : '0';

			$('#sectionRoot').innerHTML = `
				<h1 class="text-2xl font-bold mb-5">Analitik</h1>
				<div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
					<div class="stat-card"><div class="stat-label">7 Gün İşlem</div><div class="stat-value">${fmtNum(daily.reduce((a,b) => a+(b.count||0), 0))}</div></div>
					<div class="stat-card"><div class="stat-label">7 Gün Övgü</div><div class="stat-value">${fmtNum(daily.reduce((a,b) => a+(b.commends||0), 0))}</div></div>
					<div class="stat-card"><div class="stat-label">Doğrulama Oranı</div><div class="stat-value text-green-400">${verRate}%</div><div class="stat-sub">${fmtNum(ver.totalDelivered)} / ${fmtNum(ver.totalProgress)}</div></div>
					<div class="stat-card"><div class="stat-label">Ort. İşlem Süresi</div><div class="stat-value">${d.avgProcessingTimeMs ? Math.round(d.avgProcessingTimeMs/1000)+'s' : '—'}</div></div>
				</div>
				<div class="card mb-4">
					<h3 class="font-semibold mb-3">Son 7 Gün · Günlük İşlem</h3>
					<div class="flex items-end gap-1 px-2">${dailyBars || '<div class="text-gray-500 text-sm">Veri yok</div>'}</div>
				</div>
				<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
					<div class="card">
						<h3 class="font-semibold mb-3">Bugün · Saatlik Dağılım</h3>
						<div class="flex items-end gap-0.5 px-2">${hourlyBars}</div>
					</div>
					<div class="card">
						<h3 class="font-semibold mb-3">Övgü Türü Dağılımı</h3>
						<div class="space-y-3">${typeRows}</div>
					</div>
				</div>
				<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
					<div class="card">
						<h3 class="font-semibold mb-3">Hata Dağılımı</h3>
						<table class="table"><thead><tr><th>Hata Türü</th><th>Sayı</th></tr></thead><tbody>${errRows || '<tr><td colspan="2" class="text-gray-500 py-2">Hata yok</td></tr>'}</tbody></table>
					</div>
					<div class="card">
						<h3 class="font-semibold mb-3">En Çok İşlem Yapan (10)</h3>
						<table class="table"><thead><tr><th>Ad</th><th>Steam ID</th><th>İşlem</th><th>Övgü</th></tr></thead><tbody>${topRows || '<tr><td colspan="4" class="text-gray-500 py-2">Veri yok</td></tr>'}</tbody></table>
					</div>
				</div>
			`;
		}
	};

	sections.settings = {
		async load() {
			const [s, rt] = await Promise.all([api('/settings'), api('/settings/runtime')]);
			this.render(s, rt);
		},
		render(s, rt) {
			state.maintenance = !!s.maintenance;
			$('#maintenanceBadge').classList.toggle('hidden', !s.maintenance);
			$('#sectionRoot').innerHTML = `
				<h1 class="text-2xl font-bold mb-5">Ayarlar</h1>
				<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
					<div class="card">
						<h3 class="font-semibold mb-3">Yönetici Şifresi</h3>
						<div class="mb-3"><label class="label">Mevcut Şifre</label><input id="curAdminPass" type="password" class="input"></div>
						<div class="mb-3"><label class="label">Yeni Şifre (min 8 karakter)</label><input id="newAdminPass" type="password" class="input"></div>
						<button id="saveAdminPass" class="btn btn-primary btn-sm">Değiştir</button>
					</div>
					<div class="card">
						<h3 class="font-semibold mb-3">JWT Secret</h3>
						<p class="text-xs text-gray-500 mb-3">Rotasyon tüm aktif oturumları sonlandırır.</p>
						<button id="rotateJwt" class="btn btn-danger btn-sm">Yeni Secret Üret</button>
					</div>
					<div class="card">
						<h3 class="font-semibold mb-3">Discord Webhook</h3>
						<div class="mb-3"><label class="label">Webhook URL</label><input id="wh" class="input" value="${esc(s.webhookUrl || '')}" placeholder="https://discord.com/api/webhooks/..."></div>
						<div class="flex gap-2"><button id="saveWh" class="btn btn-primary btn-sm">Kaydet</button><button id="testWh" class="btn btn-secondary btn-sm">Test Mesajı</button></div>
					</div>
					<div class="card">
						<h3 class="font-semibold mb-3">Bakım Modu</h3>
						<p class="text-xs text-gray-500 mb-3">Açıkken site ziyaretçilere kapalı gösterilir.</p>
						<label class="flex items-center gap-2"><input id="maintChk" type="checkbox" ${s.maintenance ? 'checked' : ''}> <span>Bakım modu aktif</span></label>
						<button id="saveMaint" class="btn btn-primary btn-sm mt-3">Kaydet</button>
					</div>
					<div class="card lg:col-span-2">
						<h3 class="font-semibold mb-3">Çalışma Zamanı Parametreleri</h3>
						<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
							<div><label class="label">Eşzamanlılık (1-20)</label><input id="rtConc" type="number" class="input" value="${rt.concurrency ?? 3}" min="1" max="20"></div>
							<div><label class="label">Övgüler Arası Gecikme (ms)</label><input id="rtDelay" type="number" class="input" value="${rt.delayBetweenCommends ?? 2000}" min="0"></div>
							<div><label class="label">Maks Tekrar</label><input id="rtMax" type="number" class="input" value="${rt.maxRetries ?? 3}" min="0"></div>
							<div><label class="label">Doğrulama</label><select id="rtVerify" class="select"><option value="1" ${rt.verifyCommends ? 'selected' : ''}>Açık</option><option value="0" ${!rt.verifyCommends ? 'selected' : ''}>Kapalı</option></select></div>
						</div>
						<button id="saveRuntime" class="btn btn-primary btn-sm mt-4">Kaydet</button>
					</div>
					<div class="card lg:col-span-2">
						<h3 class="font-semibold mb-3">Sistem Bilgisi</h3>
						<div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
							<div><div class="text-gray-500">Node</div><div>${esc(s.nodeVersion || '—')}</div></div>
							<div><div class="text-gray-500">Platform</div><div>${esc(s.platform || '—')}</div></div>
						</div>
					</div>
				</div>
			`;
			$('#saveAdminPass').addEventListener('click', async () => {
				const cur = $('#curAdminPass').value;
				const np = $('#newAdminPass').value;
				if (!cur || !np) return toast('Her iki alan zorunlu', 'error');
				if (np.length < 8) return toast('En az 8 karakter', 'error');
				try {
					await api('/settings/password', { method: 'POST', body: JSON.stringify({ currentPassword: cur, newPassword: np }) });
					toast('Şifre değiştirildi', 'success');
					$('#curAdminPass').value = ''; $('#newAdminPass').value = '';
				} catch (e) { toast(e.message, 'error'); }
			});
			$('#rotateJwt').addEventListener('click', async () => {
				if (!confirmAction('JWT secret değiştirilsin mi? Tüm kullanıcılar tekrar giriş yapmak zorunda kalır.')) return;
				try { await api('/settings/jwt-secret', { method: 'POST' }); toast('Secret yenilendi', 'success'); setTimeout(logout, 1500); }
				catch (e) { toast(e.message, 'error'); }
			});
			$('#saveWh').addEventListener('click', async () => {
				try { await api('/settings/webhook', { method: 'POST', body: JSON.stringify({ url: $('#wh').value.trim() }) }); toast('Kaydedildi', 'success'); }
				catch (e) { toast(e.message, 'error'); }
			});
			$('#testWh').addEventListener('click', async () => {
				try { await api('/settings/webhook/test', { method: 'POST' }); toast('Test mesajı gönderildi', 'success'); }
				catch (e) { toast(e.message, 'error'); }
			});
			$('#saveMaint').addEventListener('click', async () => {
				const on = $('#maintChk').checked;
				if (on && !confirmAction('Bakım modu açılsın mı?')) return;
				try {
					await api('/settings/maintenance', { method: 'POST', body: JSON.stringify({ enabled: on }) });
					toast(on ? 'Bakım modu açık' : 'Bakım modu kapalı', 'success');
					$('#maintenanceBadge').classList.toggle('hidden', !on);
				} catch (e) { toast(e.message, 'error'); }
			});
			$('#saveRuntime').addEventListener('click', async () => {
				try {
					await api('/settings/runtime', { method: 'PATCH', body: JSON.stringify({
						concurrency: parseInt($('#rtConc').value),
						delayBetweenCommends: parseInt($('#rtDelay').value),
						maxRetries: parseInt($('#rtMax').value),
						verifyCommends: $('#rtVerify').value === '1'
					}) });
					toast('Kaydedildi', 'success');
				} catch (e) { toast(e.message, 'error'); }
			});
		}
	};

	sections.audit = {
		async load() {
			const [audit, blocked] = await Promise.all([
				api('/audit?source=db&limit=100'),
				api('/security/blocked-ips')
			]);
			this.render(audit, blocked);
		},
		render(audit, blocked) {
			const entries = audit.entries || [];
			const auditRows = entries.map(a => {
				let detail = '';
				try { detail = a.details ? JSON.stringify(typeof a.details === 'string' ? JSON.parse(a.details) : a.details) : ''; }
				catch { detail = String(a.details || ''); }
				return `
					<tr>
						<td class="text-xs text-gray-500 whitespace-nowrap">${fmtDateShort(a.created_at || a.timestamp)}</td>
						<td class="text-xs"><span class="uppercase">${esc(a.action || '')}</span></td>
						<td class="text-xs text-gray-400">${esc(a.actor || '—')}</td>
						<td class="text-xs font-mono text-gray-400">${esc(a.ip || '—')}</td>
						<td class="text-xs text-gray-400">${esc(a.target_type ? `${a.target_type}#${a.target_id}` : '')}</td>
						<td class="text-xs text-gray-500 truncate max-w-[280px]" title="${esc(detail)}">${esc(detail.slice(0, 80))}</td>
					</tr>
				`;
			}).join('');
			const blockedList = blocked.blocked || [];
			const blockedRows = blockedList.map(b => `
				<tr>
					<td class="text-xs font-mono">${esc(b.ip)}</td>
					<td class="text-xs text-gray-400">${esc(b.reason || '')}</td>
					<td class="text-xs text-gray-500">${fmtDateShort(new Date(b.until).toISOString())}</td>
					<td class="text-right"><button class="btn btn-secondary btn-sm" data-unblock="${esc(b.ip)}">Aç</button></td>
				</tr>
			`).join('');
			$('#sectionRoot').innerHTML = `
				<h1 class="text-2xl font-bold mb-5">Denetim & Güvenlik</h1>
				<div class="card mb-4">
					<h3 class="font-semibold mb-3">Engelli IP'ler (${blockedList.length})</h3>
					<div class="overflow-x-auto"><table class="table"><thead><tr><th>IP</th><th>Sebep</th><th>Bitiş</th><th></th></tr></thead><tbody>${blockedRows || '<tr><td colspan="4" class="text-center text-gray-500 py-4">Engelli IP yok</td></tr>'}</tbody></table></div>
				</div>
				<div class="card">
					<h3 class="font-semibold mb-3">Denetim Kayıtları (${audit.total || entries.length})</h3>
					<div class="overflow-x-auto max-h-[600px]"><table class="table"><thead><tr><th>Zaman</th><th>Eylem</th><th>Aktör</th><th>IP</th><th>Hedef</th><th>Detay</th></tr></thead><tbody>${auditRows || '<tr><td colspan="6" class="text-center text-gray-500 py-4">Kayıt yok</td></tr>'}</tbody></table></div>
				</div>
			`;
			$$('[data-unblock]').forEach(b => {
				b.addEventListener('click', async () => {
					try { await api('/security/blocked-ips/' + encodeURIComponent(b.dataset.unblock), { method: 'DELETE' }); toast('IP engeli kaldırıldı', 'success'); this.load(); }
					catch (e) { toast(e.message, 'error'); }
				});
			});
		}
	};

	function init() {
		$('#adminLoginForm').addEventListener('submit', handleLogin);
		$('#logoutBtn').addEventListener('click', logout);
		$$('.nav-btn').forEach(b => b.addEventListener('click', () => switchSection(b.dataset.section)));

		if (state.token) {
			api('/overview').then(() => showPanel()).catch(() => showLogin());
		} else {
			showLogin();
		}
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

	window.adminActions = {
		codesGenerate: () => sections.codes.generateModal(),
		codesGenerateSubmit: () => sections.codes.generateSubmit(),
		codesDelete: (id) => sections.codes.deleteOne(id),
		codesViewUser: (id) => sections.users.openDrawer(id),
		promosNew: () => sections.promos.newModal(),
		promosCreate: () => sections.promos.createSubmit(),
		promosToggle: (id, active) => sections.promos.toggle(id, active),
		promosDelete: (id) => sections.promos.deleteOne(id),
		promosRedemptions: (id) => sections.promos.viewRedemptions(id),
		serverSave: () => sections.server.save(),
		serverRconTest: () => sections.server.rconTest(),
		serverCheckPlayer: () => sections.server.checkPlayer(),
		serverCommendCount: () => sections.server.commendCount(),
		serverRconExec: () => sections.server.rconExec(),
		serverProxyAdd: () => sections.server.proxyAdd(),
		serverProxySaveSettings: () => sections.server.proxySaveSettings(),
		serverProxyDelete: (i) => sections.server.proxyDelete(i),
		openUserBySteamId: (sid) => openUserBySteamId(sid),
		resellerCreate: () => sections.resellers.createModal(),
		resellerCreateSubmit: () => sections.resellers.createSubmit(),
		resellerEdit: (id) => sections.resellers.editModal(id),
		resellerEditSubmit: (id) => sections.resellers.editSubmit(id),
		resellerViewCodes: (id) => sections.resellers.viewCodes(id),
		resellerDelete: (id, username) => sections.resellers.deleteOne(id, username),
		resellerResetPassword: (id) => sections.resellers.resetPassword(id),
		resellerResetUsage: (id) => sections.resellers.resetUsage(id),
		reviewApprove:        (id) => sections.reviews.approve(id),
		reviewReject:         (id) => sections.reviews.reject(id),
		reviewToggleFeatured: (id, current) => sections.reviews.toggleFeatured(id, current),
		reviewDelete:         (id) => sections.reviews.deleteOne(id),
		viewTransaction:      (id) => sections.transactions && sections.transactions.viewDetail
			? sections.transactions.viewDetail(id)
			: switchSection('transactions')
	};

	setInterval(() => {
		if (sections.reviews && sections.reviews.refreshBadge) sections.reviews.refreshBadge();
	}, 60000);
	setTimeout(() => {
		if (sections.reviews && sections.reviews.refreshBadge) sections.reviews.refreshBadge();
	}, 1500);
})();
