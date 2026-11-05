const API = '';

function getToken() {
	return localStorage.getItem('token');
}

function setToken(token) {
	localStorage.setItem('token', token);
}

function clearToken() {
	localStorage.removeItem('token');
}

function getAdminToken() {
	return localStorage.getItem('adminToken');
}

function setAdminToken(token) {
	localStorage.setItem('adminToken', token);
}

async function api(path, options = {}) {
	const token = options.adminMode ? getAdminToken() : getToken();

	const res = await fetch(API + path, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			...(token ? { 'Authorization': 'Bearer ' + token } : {}),
			...(options.headers || {})
		}
	});

	const data = await res.json();

	if (!res.ok) {
		throw new Error(data.error || 'Request failed');
	}

	return data;
}

function showToast(message, type = 'info') {
	const container = document.getElementById('toast-container');
	if (!container) return;

	const colors = {
		success: 'bg-green-600',
		error: 'bg-[#c0392b]',
		info: 'bg-blue-600',
		warning: 'bg-yellow-600'
	};

	const toast = document.createElement('div');
	toast.className = `${colors[type] || colors.info} text-white px-6 py-3 rounded-lg shadow-lg mb-2 transform transition-all duration-300 translate-x-full`;
	toast.textContent = message;

	container.appendChild(toast);

	requestAnimationFrame(() => {
		toast.classList.remove('translate-x-full');
	});

	setTimeout(() => {
		toast.classList.add('translate-x-full', 'opacity-0');
		setTimeout(() => toast.remove(), 300);
	}, 4000);
}

function formatDate(dateStr) {
	if (!dateStr) return '-';
	const d = new Date(dateStr + 'Z');
	return d.toLocaleString('tr-TR');
}

function statusBadge(status) {
	const styles = {
		pending: 'bg-yellow-500/20 text-yellow-400',
		processing: 'bg-blue-500/20 text-blue-400',
		completed: 'bg-green-500/20 text-green-400',
		failed: 'bg-red-500/20 text-red-400',
		cancelled: 'bg-gray-500/20 text-gray-400'
	};
	const style = styles[status] || styles.pending;
	return `<span class="px-2 py-1 rounded-full text-xs font-medium ${style}">${status}</span>`;
}

function playNotificationSound(type = 'info') {
	try {
		const ctx = new (window.AudioContext || window.webkitAudioContext)();
		const gain = ctx.createGain();
		gain.connect(ctx.destination);
		gain.gain.value = 0.15;

		if (type === 'success') {
			[440, 660].forEach((freq, i) => {
				const osc = ctx.createOscillator();
				osc.type = 'sine';
				osc.frequency.value = freq;
				osc.connect(gain);
				osc.start(ctx.currentTime + i * 0.12);
				osc.stop(ctx.currentTime + i * 0.12 + 0.12);
			});
		} else if (type === 'error') {
			[520, 340].forEach((freq, i) => {
				const osc = ctx.createOscillator();
				osc.type = 'square';
				osc.frequency.value = freq;
				osc.connect(gain);
				osc.start(ctx.currentTime + i * 0.15);
				osc.stop(ctx.currentTime + i * 0.15 + 0.14);
			});
		} else {
			const osc = ctx.createOscillator();
			osc.type = 'sine';
			osc.frequency.value = 480;
			osc.connect(gain);
			osc.start(ctx.currentTime);
			osc.stop(ctx.currentTime + 0.15);
		}

		setTimeout(() => ctx.close(), 500);
	} catch (e) {
	}
}

function showModal(options = {}) {
	closeModal();

	const { title = '', body = '', buttons = [], onClose } = options;

	const overlay = document.createElement('div');
	overlay.className = 'modal-overlay';
	overlay.id = 'app-modal';

	const buttonHtml = buttons.map((btn, i) =>
		`<button class="px-4 py-2 rounded-lg text-sm font-medium transition-colors ${btn.class || 'bg-gray-700 hover:bg-gray-600 text-gray-200'}" data-btn-index="${i}">${btn.label}</button>`
	).join('');

	overlay.innerHTML = `
		<div class="modal-container">
			<div class="modal-header">
				<h3>${title}</h3>
				<button class="modal-close" aria-label="Kapat">&times;</button>
			</div>
			<div class="modal-body">${body}</div>
			${buttonHtml ? `<div class="modal-footer">${buttonHtml}</div>` : ''}
		</div>
	`;

	document.body.appendChild(overlay);

	requestAnimationFrame(() => overlay.classList.add('active'));

	overlay.querySelector('.modal-close').addEventListener('click', () => closeModal());

	overlay.addEventListener('click', (e) => {
		if (e.target === overlay) closeModal();
	});

	buttons.forEach((btn, i) => {
		const el = overlay.querySelector(`[data-btn-index="${i}"]`);
		if (el && btn.onClick) {
			el.addEventListener('click', () => btn.onClick());
		}
	});

	const escHandler = (e) => {
		if (e.key === 'Escape') closeModal();
	};
	document.addEventListener('keydown', escHandler);
	overlay._escHandler = escHandler;
	overlay._onClose = onClose;

	return overlay;
}

function closeModal() {
	const overlay = document.getElementById('app-modal');
	if (!overlay) return;

	overlay.classList.remove('active');
	if (overlay._escHandler) {
		document.removeEventListener('keydown', overlay._escHandler);
	}

	setTimeout(() => {
		if (overlay._onClose) overlay._onClose();
		overlay.remove();
	}, 250);
}

function showConfirm(message, onYes, onNo) {
	return new Promise((resolve) => {
		const existing = document.getElementById('app-confirm');
		if (existing) existing.remove();

		const overlay = document.createElement('div');
		overlay.className = 'confirm-overlay';
		overlay.id = 'app-confirm';

		overlay.innerHTML = `
			<div class="confirm-dialog">
				<div class="confirm-icon">!</div>
				<div class="confirm-message">${message}</div>
				<div class="confirm-actions">
					<button class="btn-confirm btn-confirm-no">Hayır</button>
					<button class="btn-confirm btn-confirm-yes">Evet</button>
				</div>
			</div>
		`;

		document.body.appendChild(overlay);
		requestAnimationFrame(() => overlay.classList.add('active'));

		const cleanup = (result) => {
			overlay.classList.remove('active');
			setTimeout(() => overlay.remove(), 200);
			resolve(result);
		};

		overlay.querySelector('.btn-confirm-yes').addEventListener('click', () => {
			if (onYes) onYes();
			cleanup(true);
		});

		overlay.querySelector('.btn-confirm-no').addEventListener('click', () => {
			if (onNo) onNo();
			cleanup(false);
		});

		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) {
				if (onNo) onNo();
				cleanup(false);
			}
		});

		const escHandler = (e) => {
			if (e.key === 'Escape') {
				document.removeEventListener('keydown', escHandler);
				if (onNo) onNo();
				cleanup(false);
			}
		};
		document.addEventListener('keydown', escHandler);
	});
}

async function copyToClipboard(text, feedbackEl) {
	try {
		await navigator.clipboard.writeText(text);

		if (feedbackEl) {
			feedbackEl.classList.add('copied');
			if (feedbackEl.classList.contains('copy-btn')) {
				feedbackEl.classList.add('show-tooltip');
				setTimeout(() => feedbackEl.classList.remove('show-tooltip'), 1200);
			}
			setTimeout(() => feedbackEl.classList.remove('copied'), 600);
		}

		return true;
	} catch (e) {
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
		document.body.appendChild(ta);
		ta.select();
		try {
			document.execCommand('copy');
			if (feedbackEl) {
				feedbackEl.classList.add('copied');
				setTimeout(() => feedbackEl.classList.remove('copied'), 600);
			}
		} catch (_) {  }
		ta.remove();
		return false;
	}
}

function timeAgo(date) {
	const now = Date.now();
	const d = date instanceof Date ? date : new Date(date);
	const diff = now - d.getTime();

	if (diff < 0) return 'az sonra';

	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	const weeks = Math.floor(days / 7);
	const months = Math.floor(days / 30);
	const years = Math.floor(days / 365);

	if (seconds < 5)  return 'az önce';
	if (seconds < 60)  return `${seconds} saniye önce`;
	if (minutes === 1)  return '1 dakika önce';
	if (minutes < 60)  return `${minutes} dakika önce`;
	if (hours === 1)    return '1 saat önce';
	if (hours < 24)     return `${hours} saat önce`;
	if (days === 1)     return 'dün';
	if (days < 7)       return `${days} gün önce`;
	if (weeks === 1)    return '1 hafta önce';
	if (weeks < 5)      return `${weeks} hafta önce`;
	if (months === 1)   return '1 ay önce';
	if (months < 12)    return `${months} ay önce`;
	if (years === 1)    return '1 yıl önce';
	return `${years} yıl önce`;
}

function formatDuration(ms) {
	if (ms < 0) ms = 0;

	if (ms < 1000) return `${ms}ms`;

	const seconds = Math.floor(ms / 1000);
	const millis = ms % 1000;

	if (seconds < 60) {
		return millis > 0 ? `${seconds}s ${millis}ms` : `${seconds}s`;
	}

	const minutes = Math.floor(seconds / 60);
	const secs = seconds % 60;

	if (minutes < 60) {
		return secs > 0 ? `${minutes}dk ${secs}s` : `${minutes}dk`;
	}

	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	return mins > 0 ? `${hours}sa ${mins}dk` : `${hours}sa`;
}

function formatNumber(n) {
	if (n == null || isNaN(n)) return '-';
	return Number(n).toLocaleString('tr-TR');
}

function showSkeleton(containerId, count = 3) {
	const container = document.getElementById(containerId);
	if (!container) return;

	let html = '';
	for (let i = 0; i < count; i++) {
		html += `
			<div class="skeleton skeleton-card mb-3" data-skeleton>
				<div class="p-4">
					<div class="skeleton skeleton-line" style="width:70%"></div>
					<div class="skeleton skeleton-line" style="width:50%"></div>
					<div class="skeleton skeleton-line" style="width:40%"></div>
				</div>
			</div>
		`;
	}
	container.insertAdjacentHTML('afterbegin', html);
}

function hideSkeleton(containerId) {
	const container = document.getElementById(containerId);
	if (!container) return;

	container.querySelectorAll('[data-skeleton]').forEach(el => el.remove());
}

function debounce(fn, delay = 300) {
	let timer;
	return function (...args) {
		clearTimeout(timer);
		timer = setTimeout(() => fn.apply(this, args), delay);
	};
}

function throttle(fn, limit = 300) {
	let waiting = false;
	let lastArgs = null;

	return function (...args) {
		if (!waiting) {
			fn.apply(this, args);
			waiting = true;
			setTimeout(() => {
				waiting = false;
				if (lastArgs) {
					fn.apply(this, lastArgs);
					lastArgs = null;
				}
			}, limit);
		} else {
			lastArgs = args;
		}
	};
}

const eventBus = (() => {
	const listeners = {};

	return {
		on(event, callback) {
			if (!listeners[event]) listeners[event] = [];
			listeners[event].push(callback);
			return () => this.off(event, callback);
		},

		off(event, callback) {
			if (!listeners[event]) return;
			if (callback) {
				listeners[event] = listeners[event].filter(cb => cb !== callback);
			} else {
				delete listeners[event];
			}
		},

		emit(event, ...args) {
			if (!listeners[event]) return;
			listeners[event].forEach(cb => {
				try { cb(...args); } catch (e) { console.error(`EventBus [${event}]:`, e); }
			});
		}
	};
})();

const store = {
	set(key, value, ttlMs) {
		const item = {
			value,
			expiry: ttlMs ? Date.now() + ttlMs : null
		};
		try {
			localStorage.setItem('_store_' + key, JSON.stringify(item));
		} catch (e) {
		}
	},

	get(key) {
		try {
			const raw = localStorage.getItem('_store_' + key);
			if (!raw) return null;

			const item = JSON.parse(raw);

			if (item.expiry && Date.now() > item.expiry) {
				localStorage.removeItem('_store_' + key);
				return null;
			}

			return item.value;
		} catch (e) {
			return null;
		}
	},

	remove(key) {
		localStorage.removeItem('_store_' + key);
	}
};

const shortcuts = (() => {
	const registry = {};

	function normalizeCombo(combo) {
		return combo.toLowerCase().split('+').map(k => k.trim()).sort().join('+');
	}

	function handler(e) {
		const tag = (e.target.tagName || '').toLowerCase();
		if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;

		const parts = [];
		if (e.ctrlKey || e.metaKey) parts.push('ctrl');
		if (e.shiftKey) parts.push('shift');
		if (e.altKey) parts.push('alt');

		const key = e.key.toLowerCase();
		if (!['control', 'shift', 'alt', 'meta'].includes(key)) {
			parts.push(key);
		}

		const combo = parts.sort().join('+');
		const entry = registry[combo];

		if (entry) {
			e.preventDefault();
			try { entry.callback(e); } catch (err) { console.error('Shortcut error:', err); }
		}
	}

	document.addEventListener('keydown', handler);

	return {
		register(combo, callback, description = '') {
			const normalized = normalizeCombo(combo);
			registry[normalized] = { callback, description, combo };
		},

		unregister(combo) {
			delete registry[normalizeCombo(combo)];
		},

		list() {
			return Object.values(registry).map(({ combo, description }) => ({ combo, description }));
		}
	};
})();

const connectionStatus = (() => {
	let currentStatus = 'disconnected';
	let indicatorEl = null;

	function getOrCreateIndicator() {
		if (indicatorEl && document.contains(indicatorEl)) return indicatorEl;

		indicatorEl = document.getElementById('connection-status');
		return indicatorEl;
	}

	const labels = {
		connected: 'Bağlı',
		connecting: 'Bağlanıyor...',
		disconnected: 'Bağlantı kesildi',
		error: 'Bağlantı hatası'
	};

	return {
		update(status) {
			currentStatus = status;
			const el = getOrCreateIndicator();
			if (!el) return;

			const dot = el.querySelector('.connection-dot');
			const label = el.querySelector('.connection-label');

			if (dot) {
				dot.className = 'connection-dot ' + status;
			}
			if (label) {
				label.textContent = labels[status] || status;
			}

			eventBus.emit('connection:status', status);
		},

		get() {
			return currentStatus;
		}
	};
})();
