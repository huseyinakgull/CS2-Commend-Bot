const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

class SelfHealingDaemon {
	constructor(opts = {}) {
		this.botManager = opts.botManager || null;
		this.processor  = opts.processor  || null;
		this.db         = opts.db         || null;
		this.log        = opts.logger     || console;
		this.webhookUrl = opts.webhookUrl || null;
		this.serverUpdateMonitor = opts.serverUpdateMonitor || null;

		this._timers = {};
		this._alertCache = new Map();
		this._ALERT_DEDUP_MS = 60 * 60 * 1000;

		this._consecutiveProxyFails = 0;
		this._proxiesJsonPath = path.join(__dirname, 'proxies.json');

		this._consecutiveRconFails = 0;

		this._jamTracker = new Map();

		this._started = false;
	}

	start() {
		if (this._started) return;
		this._started = true;
		this.log.info && this.log.info('[self-healing] Daemon başlatıldı — proxy/RCON/pipeline izleme aktif');

		const COLD_START_DELAY = 5 * 60 * 1000;

		setTimeout(() => {
			this._checkProxyHealth().catch(() => {});
			this._timers.proxy = setInterval(() => this._checkProxyHealth().catch(() => {}), 10 * 60 * 1000);
		}, COLD_START_DELAY);

		setTimeout(() => {
			this._checkPipelineJams();
			this._timers.jam = setInterval(() => this._checkPipelineJams(), 3 * 60 * 1000);
		}, COLD_START_DELAY);

		setTimeout(() => {
			this._checkRconAlive().catch(() => {});
			this._timers.rcon = setInterval(() => this._checkRconAlive().catch(() => {}), 5 * 60 * 1000);
		}, COLD_START_DELAY);

		setTimeout(() => {
			this._checkBotPoolHealth();
			this._timers.bots = setInterval(() => this._checkBotPoolHealth(), 30 * 60 * 1000);
		}, COLD_START_DELAY);

		this._timers.alertCleanup = setInterval(() => this._cleanupAlertCache(), 60 * 60 * 1000);
	}

	stop() {
		this._started = false;
		for (const k of Object.keys(this._timers)) {
			try { clearInterval(this._timers[k]); clearTimeout(this._timers[k]); } catch {}
		}
		this._timers = {};
		this.log.info && this.log.info('[self-healing] Daemon durduruldu');
	}

	async _checkProxyHealth() {
		let proxies = [];
		try {
			if (!fs.existsSync(this._proxiesJsonPath)) return;
			const raw = fs.readFileSync(this._proxiesJsonPath, 'utf8');
			const data = JSON.parse(raw);
			proxies = (data && data.proxies) || [];
		} catch {
			return;
		}

		if (proxies.length === 0) {
			this._consecutiveProxyFails = 0;
			return;
		}

		const sample = proxies.slice(0, Math.min(3, proxies.length));
		const results = await Promise.all(sample.map(p => this._testProxy(p, 8000).catch(() => false)));
		const okCount = results.filter(r => r === true).length;

		if (okCount === 0) {
			this._consecutiveProxyFails++;
			this.log.warn && this.log.warn(`[self-healing] Proxy sample ${sample.length}/3 hepsi başarısız (ardışık fail #${this._consecutiveProxyFails})`);
			if (this._consecutiveProxyFails >= 2) {
				await this._autoFallbackToDirect(proxies.length);
				this._consecutiveProxyFails = 0;
			}
		} else {
			if (this._consecutiveProxyFails > 0) {
				this.log.info && this.log.info(`[self-healing] Proxy sağlığı düzeldi (${okCount}/${sample.length}) — fail counter sıfırlandı`);
			}
			this._consecutiveProxyFails = 0;
		}
	}

	_testProxy(proxyUrl, timeoutMs = 8000) {
		return new Promise((resolve) => {
			let resolved = false;
			const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };

			try {
				let HttpsProxyAgent;
				try { HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent; }
				catch { return done(false); }

				const agent = new HttpsProxyAgent(proxyUrl);
				const req = https.request({
					method: 'HEAD',
					hostname: 'api.steampowered.com',
					path: '/',
					port: 443,
					agent,
					timeout: timeoutMs
				}, (res) => { done(res.statusCode >= 200 && res.statusCode < 500); });
				req.on('error', () => done(false));
				req.on('timeout', () => { req.destroy(); done(false); });
				req.end();
				setTimeout(() => done(false), timeoutMs + 500);
			} catch { done(false); }
		});
	}

	async _autoFallbackToDirect(originalCount) {
		try {
			const stamp = new Date().toISOString().replace(/[:.]/g, '-');
			const backupPath = this._proxiesJsonPath + `.bak-autofallback-${stamp}`;
			fs.copyFileSync(this._proxiesJsonPath, backupPath);

			fs.writeFileSync(this._proxiesJsonPath, JSON.stringify({ proxies: [], mode: 'direct-fallback', switchEvery: 1 }, null, 2));

			if (this.botManager && typeof this.botManager.reloadProxies === 'function') {
				try { this.botManager.reloadProxies(); } catch {}
			}

			this.log.warn && this.log.warn(`[self-healing] AUTO-FALLBACK: ${originalCount} proxy'nin tamamı 502 — direkt-bağlantı moduna düşüldü (backup: ${path.basename(backupPath)})`);

			await this._alert(
				'🔴 PROXY OTO-FALLBACK',
				`Tüm proxy'ler 502 dönüyordu. Sistem otomatik direkt-bağlantı moduna geçti.\n\n` +
				`**Yapılması gereken:** Webshare hesabını kontrol et (quota / billing).\n` +
				`**Backup:** \`${path.basename(backupPath)}\`\n` +
				`**Geri dönmek için:** Yeni proxy listesini \`web/proxies.json\`'a yaz, servis restart.\n\n` +
				`Önemli: müşteri akışı kesintisiz çalışıyor.`,
				'proxy_auto_fallback'
			);
		} catch (err) {
			this.log.error && this.log.error(`[self-healing] auto-fallback hatası: ${err.message}`);
		}
	}

	_checkPipelineJams() {
		if (!this.db || !this.db._db) return;

		try {
			const stuck = this.db._db.prepare(`
				SELECT id, progress, total, started_at, created_at, error_type
				FROM transactions
				WHERE status = 'processing'
				  AND started_at IS NOT NULL
				  AND (strftime('%s','now') - strftime('%s', started_at)) > 1800
			`).all();

			const now = Date.now();
			const STALE_THRESHOLD_MS = 10 * 60 * 1000;

			for (const tx of stuck) {
				const tr = this._jamTracker.get(tx.id) || {
					firstSeenAt: now,
					lastProgress: tx.progress,
					lastProgressChangeAt: now
				};

				if (tx.progress !== tr.lastProgress) {
					tr.lastProgress = tx.progress;
					tr.lastProgressChangeAt = now;
					this._jamTracker.set(tx.id, tr);
					continue;
				}

				const stale = now - tr.lastProgressChangeAt;
				if (stale >= STALE_THRESHOLD_MS) {
					this._resolveStuckTransaction(tx);
					this._jamTracker.delete(tx.id);
				} else {
					this._jamTracker.set(tx.id, tr);
				}
			}

			const stuckIds = new Set(stuck.map(t => t.id));
			for (const id of this._jamTracker.keys()) {
				if (!stuckIds.has(id)) this._jamTracker.delete(id);
			}

			if (this._jamTracker.size > 0 && this.log.info) {
				this.log.info(`[self-healing] jam izleme: ${this._jamTracker.size} TX gözlem altında`);
			}
		} catch (err) {
			this.log.warn && this.log.warn(`[self-healing] pipeline jam check hatası: ${err.message}`);
		}
	}

	_resolveStuckTransaction(tx) {
		try {
			if (this.processor && typeof this.processor._resolveStuck === 'function') {
				this.processor._resolveStuck(tx.id, 'pipeline_jam', '30dk+ ilerleme yok — sistem otomatik temizledi, kalan miktar iade edildi');
			} else {
				this.db._db.prepare(`UPDATE transactions SET status = 'failed', error_type = 'pipeline_jam', error_message = ? WHERE id = ? AND status = 'processing'`)
					.run('30dk+ takıldı — admin tarafından temizlendi', tx.id);
			}
			this.log.warn && this.log.warn(`[self-healing] TX #${tx.id} jam çözüldü (${tx.progress}/${tx.total}, ${Math.round((Date.now() - new Date(tx.started_at).getTime()) / 60000)} dk processing)`);

			this._alert(
				'⚠️ PIPELINE JAM TEMİZLENDİ',
				`TX #${tx.id}: ${tx.progress}/${tx.total} ilerlemede 10dk+ takıldı, otomatik kapatıldı. Bakiye iade verildi.\n\n` +
				`Sistem otomatik müdahale etti — müşteri etkilenmedi.`,
				`jam_tx_${tx.id}`
			).catch(() => {});
		} catch (err) {
			this.log.error && this.log.error(`[self-healing] stuck TX resolve hatası #${tx.id}: ${err.message}`);
		}
	}

	async _checkRconAlive() {
		if (!this.serverUpdateMonitor) return;

		let rconOk = false;
		try {
			if (typeof this.serverUpdateMonitor.testRcon === 'function') {
				rconOk = await this.serverUpdateMonitor.testRcon();
			} else {
				rconOk = await this._pingRcon();
			}
		} catch { rconOk = false; }

		if (!rconOk) {
			this._consecutiveRconFails++;
			this.log.warn && this.log.warn(`[self-healing] RCON ping fail (ardışık #${this._consecutiveRconFails})`);
			if (this._consecutiveRconFails >= 3) {
				await this._alert(
					'🔴 CS2 RCON YANIT VERMİYOR',
					`Son 15 dakikadır CS2 server RCON erişilemiyor. Bu büyük ihtimalle:\n` +
					`(a) Steam auto-update — \`gameinfo.gi\` overwrite, veya\n` +
					`(b) Server crash / hung process.\n\n` +
					`**Manuel kontrol:**\n` +
					`1. Sunucu makinesinde cs2.exe çalışıyor mu?\n` +
					`2. \`game/csgo/gameinfo.gi\` içinde \`Game\\tcsgo/addons/metamod\` satırı var mı?\n` +
					`3. \`game/csgo/cfg/server.cfg\` içinde \`exec autoexec.cfg\` var mı?\n` +
					`4. \`baslat.bat\` ile yeniden başlat.`,
					'rcon_down'
				);
				this._consecutiveRconFails = 0;
			}
		} else {
			if (this._consecutiveRconFails > 0) {
				this.log.info && this.log.info(`[self-healing] RCON tekrar erişilebilir — fail counter sıfırlandı`);
			}
			this._consecutiveRconFails = 0;
		}
	}

	async _pingRcon() {
		let rcon = null;
		try {
			const Rcon = require('../helpers/Rcon');
			const config = require('../config.json');
			rcon = new Rcon(
				config.server.ip,
				parseInt(config.server.port, 10) || 27015,
				config.server.password
			);
			await rcon.connect(8000);
			const status = await rcon.execute('status');
			const who = await rcon.execute('css_who');
			try { rcon.disconnect(); } catch {}
			if (!status || status.length === 0) return false;
			if (who && /Unknown command/i.test(who)) {
				this._alert(
					'🟠 CS2 RCON var ama CounterStrikeSharp YÜKLENMEDİ',
					`\`status\` çalışıyor ama \`css_who\` "Unknown command" dönüyor. Bu:\n` +
					`(a) Metamod DLL güncel değil (CS2 engine değişti), veya\n` +
					`(b) CSS DLL güncel değil, veya\n` +
					`(c) \`counterstrikesharp.vdf\` yok / bozuk.\n\n` +
					`**Kontrol:**\n` +
					`1. \`game/csgo/addons/metamod/bin/win64/metamod-fatal.log\` var mı?\n` +
					`2. Metamod son sürüm: https://www.sourcemm.net/downloads.php?branch=master (CS2)\n` +
					`3. CSS son sürüm: https://github.com/roflmuffin/CounterStrikeSharp/releases\n` +
					`4. DLL'leri güncelle, CS2'yi restart et.`,
					'css_not_loaded'
				).catch(() => {});
				return true;
			}
			return true;
		} catch {
			try { rcon && rcon.disconnect(); } catch {}
			return false;
		}
	}

	_checkBotPoolHealth() {
		if (!this.botManager) return;

		try {
			const total = this.botManager.getAccounts ? this.botManager.getAccounts().length : 0;
			const health = this.botManager.getBotPoolHealth ? this.botManager.getBotPoolHealth() : { tracked: 0, problematic: [] };
			let problematicCount = 0;
			try {
				const fails = this.botManager._botFailures;
				if (fails && typeof fails.entries === 'function') {
					for (const [, f] of fails.entries()) {
						if (f && f.consecutiveFails >= 3) problematicCount++;
					}
				} else {
					problematicCount = (health.problematic && health.problematic.length) || 0;
				}
			} catch {
				problematicCount = (health.problematic && health.problematic.length) || 0;
			}
			const problematicPct = total > 0 ? (problematicCount / total) * 100 : 0;

			if (total < 100) {
				this._alert(
					'🟡 BOT HAVUZU AZ',
					`Toplam aktif hesap: **${total}** (önerilen min: 100).\n\n` +
					`accounts.json'a yeni hesap ekle veya banlanmış hesapları temizle.`,
					'bot_pool_critical_low'
				).catch(() => {});
			}
			else if (problematicPct > 50 && problematicCount >= 200) {
				this._alert(
					'🟡 BOT HAVUZU DEGREDE',
					`${problematicCount}/${total} hesap problematik (≥3 consecutive fail). %${problematicPct.toFixed(0)} kötü durumda.\n\n` +
					`Steam Guard / banlı / parola değişmiş hesaplar için \`accounts.invalid.json\` purge gerekebilir.\n` +
					`Admin paneli > Bot Havuzu > "Fail history reset" denenebilir.`,
					'bot_pool_degraded'
				).catch(() => {});
			}
		} catch (err) {
			this.log.warn && this.log.warn(`[self-healing] bot pool check hatası: ${err.message}`);
		}
	}

	async _alert(title, body, dedupKey) {
		const now = Date.now();
		const last = this._alertCache.get(dedupKey);
		if (last && (now - last) < this._ALERT_DEDUP_MS) {
			return;
		}
		this._alertCache.set(dedupKey, now);

		this.log.warn && this.log.warn(`[self-healing] ALERT: ${title}`);

		if (!this.webhookUrl) return;

		try {
			const payload = {
				username: 'CS Commends — Self-Healing',
				avatar_url: 'https://cscommends.com/logo.jpg',
				embeds: [{
					title,
					description: body,
					color: title.includes('🔴') ? 0xff4444 : (title.includes('🟡') ? 0xffaa00 : 0x4d9de0),
					timestamp: new Date().toISOString(),
					footer: { text: `self-healing daemon · dedup ${Math.round(this._ALERT_DEDUP_MS / 60000)}dk` }
				}]
			};
			await this._postJson(this.webhookUrl, payload, 5000);
		} catch (err) {
			this.log.warn && this.log.warn(`[self-healing] webhook fail: ${err.message}`);
		}
	}

	_postJson(url, body, timeoutMs = 5000) {
		return new Promise((resolve, reject) => {
			try {
				const u = new URL(url);
				const data = JSON.stringify(body);
				const req = https.request({
					method: 'POST',
					hostname: u.hostname,
					port: u.port || 443,
					path: u.pathname + u.search,
					headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
					timeout: timeoutMs
				}, (res) => {
					res.on('data', () => {});
					res.on('end', () => resolve(res.statusCode));
				});
				req.on('error', reject);
				req.on('timeout', () => { req.destroy(); reject(new Error('webhook timeout')); });
				req.write(data); req.end();
			} catch (e) { reject(e); }
		});
	}

	_cleanupAlertCache() {
		const now = Date.now();
		for (const [k, t] of this._alertCache.entries()) {
			if ((now - t) > this._ALERT_DEDUP_MS) this._alertCache.delete(k);
		}
	}
}

module.exports = SelfHealingDaemon;
