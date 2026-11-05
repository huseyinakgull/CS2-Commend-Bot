const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const https = require('https');

class ServerUpdateMonitor {
	constructor(logger, opts = {}) {
		this.log = logger;
		this.appId = opts.appId || 730;
		this.serverDir = opts.serverDir || 'C:\\cs2server';
		this.steamcmdPath = opts.steamcmdPath || 'C:\\steamcmd\\steamcmd.exe';
		this.batPath = opts.batPath || path.join(this.serverDir, 'baslat.bat');
		this.serverPublicIp = opts.serverPublicIp || '127.0.0.1';
		this.serverPort = opts.serverPort || 27015;
		this.checkIntervalMs = opts.checkIntervalMs || 15 * 60 * 1000;
		this.firstCheckDelayMs = opts.firstCheckDelayMs || 60 * 1000;
		this.steamcmdTimeoutMs = opts.steamcmdTimeoutMs || 15 * 60 * 1000;
		this.steamcmdInfoTimeoutMs = opts.steamcmdInfoTimeoutMs || 90 * 1000;
		this.listenerWaitMs = opts.listenerWaitMs || 90 * 1000;
		this.discordWebhook = opts.discordWebhook || null;
		this.db = opts.db || null;
		this.transactionProcessor = opts.transactionProcessor || null;
		this._timer = null;
		this._busy = false;
		this._lastKnownLatest = null;
	}

	start() {
		const intervalMin = Math.round(this.checkIntervalMs / 60000);
		this.log.info(`[server-update] watcher aktif (her ${intervalMin} dk Steam'den buildid kontrol)`);
		setTimeout(() => this._tick(), this.firstCheckDelayMs);
		this._timer = setInterval(() => this._tick(), this.checkIntervalMs);
	}

	stop() {
		if (this._timer) clearInterval(this._timer);
		this._timer = null;
	}

	async _tick() {
		if (this._busy) {
			this.log.info('[server-update] önceki update hâlâ devam ediyor, tick atlandı');
			return;
		}
		try {
			const current = this._readCurrentBuildId();
			const latest = await this._fetchLatestBuildId();

			if (!current) {
				this.log.warn('[server-update] yerel buildid okunamadı (appmanifest yok ya da bozuk)');
				return;
			}
			if (!latest) {
				this.log.warn('[server-update] Steam buildid sorgulanamadı (steamcmd timeout/error)');
				return;
			}

			this._lastKnownLatest = latest;
			if (current === latest) {
				return;
			}

			this.log.warn(`[server-update] CS2 güncellemesi mevcut: ${current} → ${latest}`);

			if (this._hasActiveTx()) {
				this.log.info('[server-update] aktif tx var → bir sonraki tick\'te tekrar bakılacak');
				await this._notify(`⏳ CS2 güncellemesi mevcut (\`${current}\` → \`${latest}\`) — aktif sipariş bitince uygulanacak.`);
				return;
			}

			await this._runUpdate(current, latest);
		} catch (err) {
			this.log.error(`[server-update] tick hata: ${err.message}`);
		}
	}

	_readCurrentBuildId() {
		try {
			const dir = this.serverDir.replace(/[\\/]+$/, '').replace(/\\/g, '/');
			const acf = `${dir}/steamapps/appmanifest_${this.appId}.acf`;
			const text = fs.readFileSync(acf, 'utf8');
			const m = text.match(/"buildid"\s+"(\d+)"/);
			return m ? m[1] : null;
		} catch {
			return null;
		}
	}

	_fetchLatestBuildId() {
		return new Promise((resolve) => {
			const args = [
				'+@ShutdownOnFailedCommand', '0',
				'+login', 'anonymous',
				'+app_info_update', '1',
				'+app_info_print', String(this.appId),
				'+quit'
			];
			const proc = spawn(this.steamcmdPath, args, { windowsHide: true });
			let out = '';
			const timer = setTimeout(() => {
				try { proc.kill(); } catch {}
				resolve(null);
			}, this.steamcmdInfoTimeoutMs);

			proc.stdout.on('data', d => out += d.toString('utf8'));
			proc.stderr.on('data', d => out += d.toString('utf8'));
			proc.on('error', () => { clearTimeout(timer); resolve(null); });
			proc.on('close', () => {
				clearTimeout(timer);
				try {
					const branchStart = out.indexOf('"branches"');
					if (branchStart < 0) return resolve(null);
					const slice = out.substring(branchStart, branchStart + 5000);
					const m = slice.match(/"public"\s*\{[\s\S]*?"buildid"\s+"(\d+)"/);
					resolve(m ? m[1] : null);
				} catch {
					resolve(null);
				}
			});
		});
	}

	_hasActiveTx() {
		if (!this.db) return false;
		try {
			const r = this.db.prepare(
				"SELECT COUNT(*) as c FROM transactions WHERE status IN ('pending','processing')"
			).get();
			return (r && r.c > 0);
		} catch (e) {
			this.log.warn(`[server-update] aktif tx kontrol hata: ${e.message}`);
			return false;
		}
	}

	async _runUpdate(fromBuild, toBuild) {
		this._busy = true;
		const startTs = Date.now();

		const wasRunning = this._stopProcessor();

		try {
			this.log.warn(`[server-update] ⚙ update başlıyor: ${fromBuild} → ${toBuild}`);
			await this._notify(`🔄 CS2 sunucusu güncelleniyor: \`${fromBuild}\` → \`${toBuild}\``);

			this.log.info('[server-update] cmd.exe (baslat.bat) + cs2.exe kapatılıyor...');
			await this._stopServer();

			this.log.info('[server-update] steamcmd update başlatıldı (validate)...');
			const ok = await this._runSteamcmdUpdate();

			if (!ok) {
				this.log.error('[server-update] steamcmd update başarısız — eski sürümle restart');
				await this._notify(`❌ CS2 update başarısız (steamcmd validate fail) — eski sürümle yeniden başlatılıyor. Manuel kontrol gerekli.`);
				await this._startServer();
				await this._waitForListener();
				return;
			}

			this.log.info('[server-update] sunucu yeniden başlatılıyor (baslat.bat)...');
			await this._startServer();

			this.log.info('[server-update] 27015 listener bekleniyor...');
			const listenerReady = await this._waitForListener();
			if (!listenerReady) {
				this.log.error('[server-update] listener 90s içinde açılmadı');
				await this._notify(`⚠️ CS2 update yapıldı ama 27015 listener 90s içinde açılmadı — manuel kontrol gerekli.`);
				return;
			}

			const elapsedSec = Math.round((Date.now() - startTs) / 1000);
			this.log.success(`[server-update] ✓ tamamlandı (${elapsedSec}s) → buildid ${toBuild}`);
			await this._notify(`✅ CS2 sunucusu güncellendi: \`${fromBuild}\` → \`${toBuild}\` (${elapsedSec}s)`);
		} catch (err) {
			this.log.error(`[server-update] runUpdate hata: ${err.message}`);
			await this._notify(`❌ CS2 update exception: ${err.message}`);
		} finally {
			this._busy = false;
			if (wasRunning) this._startProcessor();
		}
	}

	_stopProcessor() {
		if (!this.transactionProcessor) return false;
		try {
			if (typeof this.transactionProcessor.stop === 'function') {
				this.transactionProcessor.stop();
				this.log.info('[server-update] transaction processor duraklatıldı');
				return true;
			}
		} catch (e) {
			this.log.warn(`[server-update] processor stop hata: ${e.message}`);
		}
		return false;
	}

	_startProcessor() {
		if (!this.transactionProcessor) return;
		try {
			if (typeof this.transactionProcessor.start === 'function') {
				this.transactionProcessor.start();
				this.log.info('[server-update] transaction processor yeniden başlatıldı');
			}
		} catch (e) {
			this.log.warn(`[server-update] processor start hata: ${e.message}`);
		}
	}

	_runPowerShell(cmd, timeoutMs = 15000) {
		return new Promise((resolve) => {
			const proc = spawn('powershell.exe', ['-NoProfile', '-Command', cmd], { windowsHide: true });
			let out = '';
			const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve(out); }, timeoutMs);
			proc.stdout.on('data', d => out += d.toString('utf8'));
			proc.stderr.on('data', d => out += d.toString('utf8'));
			proc.on('close', () => { clearTimeout(timer); resolve(out); });
			proc.on('error', () => { clearTimeout(timer); resolve(out); });
		});
	}

	async _stopServer() {
		const ps = `
			$cmds = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*baslat*' -or $_.CommandLine -like '*cs2server*' };
			foreach ($c in $cmds) { Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue };
			Start-Sleep -Milliseconds 600;
			Get-Process cs2 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue };
			Start-Sleep -Milliseconds 1500;
			Write-Output "STOP-OK"
		`;
		await this._runPowerShell(ps, 20000);
	}

	async _startServer() {
		const ps = `
			$p = Start-Process -FilePath 'C:\\Windows\\System32\\cmd.exe' -ArgumentList '/c','${this.batPath.replace(/\\/g, '\\\\')}' -WorkingDirectory '${this.serverDir.replace(/\\/g, '\\\\')}' -PassThru -WindowStyle Minimized;
			Write-Output ("PID:" + $p.Id)
		`;
		await this._runPowerShell(ps, 10000);
	}

	_runSteamcmdUpdate() {
		return new Promise((resolve) => {
			const args = [
				'+force_install_dir', this.serverDir,
				'+login', 'anonymous',
				'+app_update', String(this.appId), 'validate',
				'+quit'
			];
			const proc = spawn(this.steamcmdPath, args, { windowsHide: true });
			let out = '';
			const timer = setTimeout(() => {
				try { proc.kill(); } catch {}
				this.log.error('[server-update] steamcmd timeout (15dk aşıldı)');
				resolve(false);
			}, this.steamcmdTimeoutMs);

			proc.stdout.on('data', d => {
				const s = d.toString('utf8');
				out += s;
				const m = s.match(/Update state \(0x[0-9a-f]+\) [^,]+, progress: (\d+\.\d+)/i);
				if (m) this.log.info(`[server-update] steamcmd: ${m[0]}`);
			});
			proc.stderr.on('data', d => out += d.toString('utf8'));
			proc.on('error', () => { clearTimeout(timer); resolve(false); });
			proc.on('close', () => {
				clearTimeout(timer);
				const success = /Success!\s+App\s+'\d+'\s+fully installed/i.test(out);
				if (!success) {
					const errMatch = out.match(/Error![^\n]*/);
					this.log.error(`[server-update] steamcmd hata: ${errMatch ? errMatch[0] : 'fully-installed mesajı bulunamadı'}`);
				}
				resolve(success);
			});
		});
	}

	async _waitForListener() {
		const start = Date.now();
		while (Date.now() - start < this.listenerWaitMs) {
			if (await this._isListenerOpen()) return true;
			await new Promise(r => setTimeout(r, 2000));
		}
		return false;
	}

	_isListenerOpen() {
		return new Promise((resolve) => {
			const s = net.createConnection({ host: this.serverPublicIp, port: this.serverPort, timeout: 2000 });
			let done = false;
			const finish = (ok) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(ok); };
			s.on('connect', () => finish(true));
			s.on('error', () => finish(false));
			s.on('timeout', () => finish(false));
		});
	}

	_notify(content) {
		return new Promise((resolve) => {
			if (!this.discordWebhook) return resolve();
			try {
				const payload = JSON.stringify({ content });
				const url = new URL(this.discordWebhook);
				const req = https.request({
					method: 'POST',
					hostname: url.hostname,
					path: url.pathname + url.search,
					headers: {
						'Content-Type': 'application/json',
						'Content-Length': Buffer.byteLength(payload)
					},
					timeout: 5000
				}, res => { res.resume(); res.on('end', resolve); });
				req.on('error', () => resolve());
				req.on('timeout', () => { try { req.destroy(); } catch {} resolve(); });
				req.write(payload);
				req.end();
			} catch { resolve(); }
		});
	}

	async forceCheck() {
		await this._tick();
	}

	getStatus() {
		return {
			busy: this._busy,
			currentBuild: this._readCurrentBuildId(),
			lastKnownLatest: this._lastKnownLatest,
			checkIntervalMs: this.checkIntervalMs
		};
	}
}

module.exports = ServerUpdateMonitor;
