(function() {
	if (window.__CSRF_HELPER_INSTALLED__) return;
	window.__CSRF_HELPER_INSTALLED__ = true;

	const origFetch = window.fetch;
	if (typeof origFetch !== 'function') return;

	function readCsrfCookie() {
		const m = document.cookie.match(/(?:^|;\s*)csrf_token=([a-f0-9]{64})/);
		return m ? m[1] : '';
	}

	function shouldInject(input, init) {
		const method = ((init && init.method) || (typeof input === 'object' && input && input.method) || 'GET').toUpperCase();
		if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;

		let url = '';
		try {
			if (typeof input === 'string') url = input;
			else if (input instanceof URL) url = input.href;
			else if (input && typeof input.url === 'string') url = input.url;
		} catch { return false; }
		if (!url) return false;

		let pathname;
		try {
			const u = new URL(url, window.location.origin);
			if (u.origin !== window.location.origin) return false;
			pathname = u.pathname;
		} catch { return false; }
		return pathname.startsWith('/api/');
	}

	window.fetch = function(input, init) {
		if (!shouldInject(input, init)) return origFetch(input, init);
		const csrf = readCsrfCookie();
		if (!csrf) return origFetch(input, init);
		init = init ? Object.assign({}, init) : {};
		const headers = new Headers(init.headers || {});
		if (!headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', csrf);
		init.headers = headers;
		if (!init.credentials) init.credentials = 'same-origin';
		return origFetch(input, init);
	};
})();
