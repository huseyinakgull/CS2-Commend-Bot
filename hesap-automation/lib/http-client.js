const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const COOKIE_JAR_PATH = path.join(__dirname, '..', 'data', 'cookies.txt');
const STORAGE_STATE_PATH = path.join(__dirname, '..', 'data', 'storage-state.json');

function _detectCurlPath() {
	if (process.env.HESAP_CURL_PATH) return process.env.HESAP_CURL_PATH;
	const candidates = process.platform !== 'win32' ? [] : [
		'C:\\Program Files\\Git\\mingw64\\bin\\curl.exe',
		'C:\\Program Files (x86)\\Git\\mingw64\\bin\\curl.exe',
		'C:\\Program Files\\Git\\mingw32\\bin\\curl.exe'
	];
	for (const p of candidates) {
		if (fs.existsSync(p)) return p;
	}
	console.warn('[hesap-http] ⚠ Modern curl bulunamadı, Windows native fallback (Cloudflare 403 olası)');
	return 'curl';
}
const CURL_PATH = _detectCurlPath();
console.log(`[hesap-http] curl path: ${CURL_PATH}`);

const DEFAULT_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
	'(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

class HesapHttpClient {
	constructor(opts = {}) {
		this.baseUrl = opts.baseUrl || 'https://hesap.com.tr';
		this.userAgent = opts.userAgent || DEFAULT_UA;
		this.proxy = opts.proxy || null;
		this._migrateCookiesIfNeeded();
	}

	_migrateCookiesIfNeeded() {
		if (fs.existsSync(COOKIE_JAR_PATH)) return;
		if (!fs.existsSync(STORAGE_STATE_PATH)) return;

		try {
			const ss = JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, 'utf8'));
			const cookies = ss.cookies || [];
			const lines = ['# Netscape HTTP Cookie File'];
			for (const c of cookies) {
				const domain = c.domain.startsWith('.') ? c.domain : c.domain;
				const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
				const path_ = c.path || '/';
				const secure = c.secure ? 'TRUE' : 'FALSE';
				const expires = Math.floor(c.expires || (Date.now() / 1000 + 86400 * 30));
				lines.push(`${domain}\t${flag}\t${path_}\t${secure}\t${expires}\t${c.name}\t${c.value}`);
			}
			fs.writeFileSync(COOKIE_JAR_PATH, lines.join('\n'));
			console.log(`[hesap-http] storage-state.json'dan ${cookies.length} cookie cookies.txt'e migrate edildi`);
		} catch (err) {
			console.warn('[hesap-http] migrate hata:', err.message);
		}
	}

	_buildCurlArgs(method, url, opts = {}) {
		const fullUrl = url.startsWith('http') ? url : (this.baseUrl + url);
		const args = [
			'-s',
			'-i',
			'--max-time', String(Math.floor((opts.timeout || 30000) / 1000)),
			'-X', method,
			'-A', this.userAgent,
			'-H', 'Accept-Encoding: identity',
			'-H', 'Accept-Language: tr-TR,tr;q=0.9,en;q=0.8',
			'-b', COOKIE_JAR_PATH,
			'-c', COOKIE_JAR_PATH
		];

		if (opts.followRedirect) args.push('-L');

		if (this.proxy) {
			let proxyUrl = this.proxy.server;
			if (this.proxy.username && this.proxy.password) {
				const u = new URL(proxyUrl);
				u.username = this.proxy.username;
				u.password = this.proxy.password;
				proxyUrl = u.toString();
			}
			args.push('-x', proxyUrl);
		}

		if (opts.headers) {
			for (const [k, v] of Object.entries(opts.headers)) {
				args.push('-H', `${k}: ${v}`);
			}
		}

		if (opts.data !== undefined) {
			if (typeof opts.data === 'string') {
				args.push('-d', opts.data);
			} else if (typeof opts.data === 'object') {
				args.push('-H', 'Content-Type: application/json');
				args.push('-d', JSON.stringify(opts.data));
			}
		}
		if (opts.formData) {
			args.push('-H', 'Content-Type: application/x-www-form-urlencoded');
			const usp = new URLSearchParams(opts.formData);
			args.push('-d', usp.toString());
		}

		args.push(fullUrl);
		return args;
	}

	_curl(method, url, opts = {}) {
		return new Promise((resolve, reject) => {
			const args = this._buildCurlArgs(method, url, opts);
			const child = spawn(CURL_PATH, args, { windowsHide: true });
			const stdoutChunks = [];
			const stderrChunks = [];
			child.stdout.on('data', c => stdoutChunks.push(c));
			child.stderr.on('data', c => stderrChunks.push(c));
			child.on('error', reject);
			child.on('close', (code) => {
				if (code !== 0 && code !== null) {
					return reject(new Error(`curl exit ${code}: ${Buffer.concat(stderrChunks).toString()}`));
				}
				const raw = Buffer.concat(stdoutChunks).toString('utf8');
				resolve(this._parseRawResponse(raw, url));
			});
		});
	}

	_parseRawResponse(raw, requestUrl) {
		const blocks = [];
		let remaining = raw;
		while (remaining.length > 0) {
			const headerEnd = remaining.indexOf('\r\n\r\n');
			if (headerEnd === -1) {
				if (remaining.includes('HTTP/')) {
					blocks.push({ headers: remaining, body: '' });
				}
				break;
			}
			const headerSection = remaining.substring(0, headerEnd);
			const afterHeader = remaining.substring(headerEnd + 4);

			const nextHttpIdx = afterHeader.indexOf('HTTP/');
			let body, nextRemaining;
			if (nextHttpIdx >= 0 && nextHttpIdx < 200) {
				body = afterHeader.substring(0, nextHttpIdx);
				nextRemaining = afterHeader.substring(nextHttpIdx);
			} else {
				body = afterHeader;
				nextRemaining = '';
			}
			blocks.push({ headers: headerSection, body });
			remaining = nextRemaining;
		}

		if (blocks.length === 0) {
			return { status: 0, headers: {}, data: raw, _redirectChain: [], _finalUrl: requestUrl };
		}

		const last = blocks[blocks.length - 1];
		const statusLine = last.headers.split(/\r?\n/)[0] || '';
		const statusMatch = statusLine.match(/HTTP\/[\d.]+\s+(\d+)/);
		const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

		const headers = {};
		const headerLines = last.headers.split(/\r?\n/).slice(1);
		for (const line of headerLines) {
			const idx = line.indexOf(':');
			if (idx === -1) continue;
			const k = line.substring(0, idx).trim().toLowerCase();
			const v = line.substring(idx + 1).trim();
			if (headers[k]) {
				headers[k] = Array.isArray(headers[k]) ? [...headers[k], v] : [headers[k], v];
			} else {
				headers[k] = v;
			}
		}

		const redirectChain = [];
		for (let i = 0; i < blocks.length - 1; i++) {
			const b = blocks[i];
			const slMatch = (b.headers.split(/\r?\n/)[0] || '').match(/HTTP\/[\d.]+\s+(\d+)/);
			const locMatch = b.headers.match(/^Location:\s*(.+?)$/im);
			if (slMatch && locMatch) {
				redirectChain.push({ status: parseInt(slMatch[1], 10), location: locMatch[1].trim() });
			}
		}

		let finalUrl = requestUrl;
		if (redirectChain.length > 0) {
			finalUrl = redirectChain[redirectChain.length - 1].location;
		}

		return {
			status,
			headers,
			data: last.body,
			_redirectChain: redirectChain,
			_finalUrl: finalUrl,
			_blockCount: blocks.length
		};
	}

	async get(url, opts = {}) {
		return this._curl('GET', url, { ...opts, followRedirect: opts.followRedirect !== false });
	}

	async post(url, data, opts = {}) {
		const xsrf = await this._getCookie('XSRF-TOKEN');
		const headers = {
			'X-Requested-With': 'XMLHttpRequest',
			...(opts.headers || {})
		};
		if (xsrf) {
			headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf);
		}
		return this._curl('POST', url, { ...opts, data, headers });
	}

	async _getCookie(name) {
		try {
			if (!fs.existsSync(COOKIE_JAR_PATH)) return null;
			const text = fs.readFileSync(COOKIE_JAR_PATH, 'utf8');
			const lines = text.split('\n').filter(l => !l.startsWith('#') && l.trim());
			for (const line of lines) {
				const parts = line.split('\t');
				if (parts.length >= 7 && parts[5] === name) return parts[6];
			}
			return null;
		} catch {
			return null;
		}
	}

	async isLoggedIn() {
		try {
			const r = await this.get('/p/ilanlarim');
			if (r.status === 200) {
				const finalUrl = r._finalUrl || '/p/ilanlarim';
				return !finalUrl.includes('/login');
			}
			return false;
		} catch (err) {
			console.warn('[hesap-http] isLoggedIn hata:', err.message);
			return false;
		}
	}
}

module.exports = { HesapHttpClient, COOKIE_JAR_PATH };
