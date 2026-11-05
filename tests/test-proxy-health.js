const http = require('http');
const url = require('url');

const proxiesData = require('./web/proxies.json');
const proxies = proxiesData.proxies;

const TIMEOUT = 10000;
const TEST_URL = 'http://httpbin.org/ip';

function testProxy(proxyUrl) {
	return new Promise((resolve) => {
		const parsed = new url.URL(proxyUrl);
		const timer = setTimeout(() => {
			resolve({ proxy: proxyUrl, ok: false, error: 'timeout' });
		}, TIMEOUT);

		try {
			const req = http.request({
				host: parsed.hostname,
				port: parseInt(parsed.port),
				path: TEST_URL,
				method: 'GET',
				headers: {
					'Proxy-Authorization': 'Basic ' + Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64'),
					'Host': 'httpbin.org'
				},
				timeout: TIMEOUT
			}, (res) => {
				let body = '';
				res.on('data', d => body += d.toString());
				res.on('end', () => {
					clearTimeout(timer);
					if (res.statusCode === 200) {
						let ip = '';
						try { ip = JSON.parse(body).origin; } catch {}
						resolve({ proxy: proxyUrl, ok: true, status: res.statusCode, ip });
					} else {
						resolve({ proxy: proxyUrl, ok: false, error: `HTTP ${res.statusCode}`, status: res.statusCode });
					}
				});
			});

			req.on('error', (err) => {
				clearTimeout(timer);
				resolve({ proxy: proxyUrl, ok: false, error: err.code || err.message });
			});

			req.on('timeout', () => {
				clearTimeout(timer);
				req.destroy();
				resolve({ proxy: proxyUrl, ok: false, error: 'request timeout' });
			});

			req.end();
		} catch (err) {
			clearTimeout(timer);
			resolve({ proxy: proxyUrl, ok: false, error: err.message });
		}
	});
}

async function main() {
	console.log(`\n  Proxy Health Check — ${proxies.length} proxy test ediliyor\n`);
	console.log(`  Test: HTTP GET ${TEST_URL} (proxy üzerinden)\n`);

	const BATCH = 10;
	let ok = 0;
	let fail = 0;
	const failures = [];
	const ips = new Set();

	for (let i = 0; i < proxies.length; i += BATCH) {
		const batch = proxies.slice(i, i + BATCH);
		const results = await Promise.all(batch.map(p => testProxy(p)));

		for (const r of results) {
			const addr = r.proxy.match(/@(.+)$/)?.[1] || r.proxy;
			if (r.ok) {
				ok++;
				if (r.ip) ips.add(r.ip);
				process.stdout.write(`  ✓ ${addr}${r.ip ? ` → ${r.ip}` : ''}\n`);
			} else {
				fail++;
				failures.push(r);
				process.stdout.write(`  ✗ ${addr} — ${r.error}\n`);
			}
		}
	}

	console.log(`\n  ════════════════════════════════════════`);
	console.log(`  Sonuç: ${ok} ✓ çalışıyor / ${fail} ✗ başarısız / ${proxies.length} toplam`);
	if (ips.size > 0) {
		console.log(`  Benzersiz IP: ${ips.size} adet`);
	}

	if (fail > 0) {
		console.log(`\n  Başarısız proxy'ler:`);
		const byError = {};
		for (const f of failures) {
			const key = f.error;
			if (!byError[key]) byError[key] = 0;
			byError[key]++;
		}
		for (const [err, count] of Object.entries(byError)) {
			console.log(`    ${err}: ${count} adet`);
		}
	}

	if (ok === 0) {
		console.log(`\n  ⚠ HİÇBİR PROXY ÇALIŞMIYOR`);
		console.log(`  NOT: Bu test HTTP üzerinden çalışır. steam-user farklı yöntem kullandığı`);
		console.log(`  için proxy'ler Steam login'de çalışıyor olabilir (test-validate ile doğrula).`);
	} else if (fail > proxies.length * 0.3) {
		console.log(`\n  ⚠ %${Math.round(fail / proxies.length * 100)} başarısız — proxy havuzunu gözden geçir`);
	} else {
		console.log(`\n  ✓ Proxy havuzu sağlıklı`);
	}

	console.log('');
	process.exit(fail > 0 ? 1 : 0);
}

main();
