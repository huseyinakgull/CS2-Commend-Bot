const Rcon = require('../helpers/Rcon');
const cfg = require('../config.json').server;

const DEFAULT_THRESHOLD = 10;
const DEFAULT_INTERVAL_MS = 3 * 60 * 1000;
const RCON_TIMEOUT_MS = 8000;

const MAX_DEFERRED_SKIPS = 6;

class SlotWatcher {
	constructor(logger = null, opts = {}) {
		this.log = logger || {
			info: (m) => console.log(`[slot-watcher] ${new Date().toLocaleTimeString('tr-TR')} ${m}`),
			warn: (m) => console.log(`[slot-watcher] WARN ${new Date().toLocaleTimeString('tr-TR')} ${m}`),
			error: (m) => console.error(`[slot-watcher] ERR ${new Date().toLocaleTimeString('tr-TR')} ${m}`),
			success: (m) => console.log(`[slot-watcher] OK ${new Date().toLocaleTimeString('tr-TR')} ${m}`)
		};
		this.threshold = opts.threshold || DEFAULT_THRESHOLD;
		this.intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
		this.timer = null;
		this.running = false;
		this.getActiveTxCount = opts.getActiveTxCount || (() => 0);
		this.deferredSkips = 0;
		this.stats = {
			checks: 0,
			cleanups: 0,
			softCleanups: 0,
			deferredDueToActiveTx: 0,
			forcedCleanupsAfterDefer: 0,
			lastCount: 0,
			lastCleanupAt: null,
			lastSoftCleanupAt: null,
			lastDeferAt: null
		};
	}

	async checkOnce() {
		if (this.running) return;
		this.running = true;
		const r = new Rcon(cfg.ip, +cfg.port, cfg.password);
		try {
			await r.connect(RCON_TIMEOUT_MS);
			const status = await r.execute('status');
			const count = (status.match(/challenging/g) || []).length;
			this.stats.checks++;
			this.stats.lastCount = count;

			if (count >= this.threshold) {
				const m = status.match(/\[1:\s+([\w_]+)\s*\|/);
				const mapName = m ? m[1] : 'de_dust2';

				try {
					await r.execute('css_auth_clear');
					this.stats.softCleanups++;
					this.stats.lastSoftCleanupAt = new Date().toISOString();
					this.log.info(`SOFT-CLEAN stuck=${count} → css_auth_clear gönderildi (kimse atılmadı)`);
				} catch (e) {
					this.log.warn(`css_auth_clear FAIL: ${e.message} — changelevel yoluna düşülüyor`);
				}

				const activeTx = this.getActiveTxCount();
				if (activeTx > 0 && this.deferredSkips < MAX_DEFERRED_SKIPS) {
					this.deferredSkips++;
					this.stats.deferredDueToActiveTx++;
					this.stats.lastDeferAt = new Date().toISOString();
					this.log.warn(`DEFER changelevel — ${activeTx} aktif TX var (skip ${this.deferredSkips}/${MAX_DEFERRED_SKIPS}). Sonraki check'te tekrar denenecek.`);
					return;
				}

				if (activeTx > 0 && this.deferredSkips >= MAX_DEFERRED_SKIPS) {
					this.stats.forcedCleanupsAfterDefer++;
					this.log.warn(`FORCE changelevel — ${this.deferredSkips} kez ertelendi ama hâlâ ${activeTx} aktif TX. Deadlock önlemek için zorla temizlik (oyuncular atılacak).`);
				}

				this.log.warn(`STUCK slot=${count} (>=${this.threshold}) → changelevel ${mapName}`);
				try {
					await r.execute('changelevel ' + mapName);
					this.stats.cleanups++;
					this.stats.lastCleanupAt = new Date().toISOString();
					this.deferredSkips = 0;
					this.log.success(`changelevel ${mapName} gönderildi — slot reset bekleniyor`);
				} catch (e) {
					this.log.error(`changelevel FAIL: ${e.message}`);
				}
			} else {
				this.log.info(`OK stuck=${count}/${this.threshold} (sağlıklı)`);
				if (this.deferredSkips > 0) {
					this.log.info(`Defer counter sıfırlandı (önceden ${this.deferredSkips} skip vardı)`);
					this.deferredSkips = 0;
				}
			}
		} catch (e) {
			this.log.error(`RCON FAIL: ${e.message}`);
		} finally {
			try { r.disconnect(); } catch (_) { }
			this.running = false;
		}
	}

	start() {
		if (this.timer) return;
		this.log.info(`Slot watcher başlatıldı (threshold=${this.threshold}, interval=${Math.round(this.intervalMs / 1000)}s)`);
		setTimeout(() => this.checkOnce(), 5000);
		this.timer = setInterval(() => this.checkOnce(), this.intervalMs);
	}

	stop() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
			this.log.info('Slot watcher durduruldu');
		}
	}

	getStats() {
		return { ...this.stats };
	}
}

module.exports = SlotWatcher;

if (require.main === module) {
	const watcher = new SlotWatcher(null, {
		threshold: parseInt(process.env.SLOT_THRESHOLD || '10', 10),
		intervalMs: parseInt(process.env.SLOT_INTERVAL_MS || (3 * 60 * 1000).toString(), 10)
	});
	watcher.start();
	process.on('SIGINT', () => { watcher.stop(); process.exit(0); });
	process.on('SIGTERM', () => { watcher.stop(); process.exit(0); });
}
