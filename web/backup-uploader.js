const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const crypto = require('crypto');

const BACKUP_MAGIC = Buffer.from('CSBAK1', 'utf8');

function _deriveBackupKey(logger) {
	const explicit = process.env.BACKUP_ENCRYPTION_KEY;
	if (explicit && explicit.length >= 32) {
		return crypto.scryptSync(explicit, 'cscommends-backup-v1', 32);
	}
	let webCfg;
	try { webCfg = require('./config.json'); } catch { webCfg = {}; }
	const fallback = process.env.JWT_SECRET || webCfg.jwtSecret || 'DEV-INSECURE-FALLBACK';
	if (fallback === 'DEV-INSECURE-FALLBACK' && logger?.warn) {
		logger.warn('[backup-uploader] BACKUP_ENCRYPTION_KEY yok, JWT_SECRET de yok — dev fallback (production için .env düzenle)');
	} else if (logger?.warn && !explicit) {
		logger.warn('[backup-uploader] BACKUP_ENCRYPTION_KEY yok; JWT_SECRET türeviyle şifrelenecek — dedicated key önerilir');
	}
	return crypto.scryptSync(fallback, 'cscommends-backup-v1', 32);
}

class BackupUploader {
	constructor(logger, opts = {}) {
		this.log = logger;
		this.webhookUrl = opts.webhookUrl || null;
		this.backupsDir = opts.backupsDir || path.join(__dirname, 'backups');
		this.intervalHours = opts.intervalHours || 24;
		this.gzip = opts.gzip !== false;
		this.encrypt = opts.encrypt !== false;
		this.maxBytes = opts.maxBytes || 24 * 1024 * 1024;
		this._encKey = this.encrypt ? _deriveBackupKey(logger) : null;
		this._timer = null;
	}

	_encryptPayload(buf) {
		const iv = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv('aes-256-gcm', this._encKey, iv);
		const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
		const tag = cipher.getAuthTag();
		return Buffer.concat([BACKUP_MAGIC, iv, tag, ct]);
	}

	static decrypt(encBuf, secret) {
		if (encBuf.length < 6 + 12 + 16) throw new Error('backup dosyası çok kısa');
		const magic = encBuf.slice(0, 6);
		if (!magic.equals(BACKUP_MAGIC)) throw new Error('geçersiz backup magic — CSBAK1 bekleniyordu');
		const iv = encBuf.slice(6, 18);
		const tag = encBuf.slice(18, 34);
		const ct = encBuf.slice(34);
		const key = crypto.scryptSync(secret, 'cscommends-backup-v1', 32);
		const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(ct), decipher.final()]);
	}

	start() {
		if (!this.webhookUrl) {
			this.log.warn('[backup-uploader] webhookUrl yok — off-site backup pasif');
			return;
		}
		const intervalMs = this.intervalHours * 60 * 60 * 1000;
		this.log.info(`[backup-uploader] başlatıldı (her ${this.intervalHours}h Discord'a upload)`);
		setTimeout(() => this.uploadLatest().catch(e => this.log.error('[backup-uploader] init upload err: ' + e.message)), 5 * 60 * 1000);
		this._timer = setInterval(() => {
			this.uploadLatest().catch(e => this.log.error('[backup-uploader] tick err: ' + e.message));
		}, intervalMs);
	}

	stop() {
		if (this._timer) clearInterval(this._timer);
		this._timer = null;
	}

	_findLatestBackup() {
		if (!fs.existsSync(this.backupsDir)) return null;
		const files = fs.readdirSync(this.backupsDir)
			.filter(f => f.startsWith('data-') && f.endsWith('.sqlite'))
			.map(f => ({ name: f, full: path.join(this.backupsDir, f), mtime: fs.statSync(path.join(this.backupsDir, f)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);
		return files.length ? files[0] : null;
	}

	async uploadLatest() {
		const latest = this._findLatestBackup();
		if (!latest) {
			this.log.warn('[backup-uploader] yüklenebilir backup bulunamadı (data-*.sqlite yok)');
			return false;
		}

		let payload;
		let filename;
		const stat = fs.statSync(latest.full);
		const ageMin = Math.round((Date.now() - latest.mtime) / 60000);

		if (this.gzip) {
			const raw = fs.readFileSync(latest.full);
			payload = zlib.gzipSync(raw, { level: 9 });
			filename = latest.name + '.gz';
		} else {
			payload = fs.readFileSync(latest.full);
			filename = latest.name;
		}

		if (this.encrypt) {
			payload = this._encryptPayload(payload);
			filename = filename + '.enc';
		}

		if (payload.length > this.maxBytes) {
			this.log.error(`[backup-uploader] backup ${filename} çok büyük (${payload.length} bytes > ${this.maxBytes}), atlandı`);
			return false;
		}

		const sizeKB = Math.round(payload.length / 1024);
		const origMB = (stat.size / (1024 * 1024)).toFixed(2);
		const compressedRatio = this.gzip ? Math.round((1 - (this.encrypt ? payload.length - 34 : payload.length) / stat.size) * 100) : 0;

		const encTag = this.encrypt ? ' + AES-256-GCM' : '';
		const summary = `🗄️ **Daily DB Backup** \`${filename}\`\n` +
			`Boyut: ${sizeKB} KB ${this.gzip ? `(gzip%${compressedRatio}${encTag}; orijinal ${origMB} MB)` : `(${origMB} MB raw${encTag})`}\n` +
			`Snapshot yaşı: ${ageMin} dk\n` +
			`Hostname: ${require('os').hostname()}`;

		try {
			await this._postMultipart(filename, payload, summary);
			this.log.success(`[backup-uploader] ✓ ${filename} Discord'a yüklendi (${sizeKB} KB)`);
			return true;
		} catch (e) {
			this.log.error(`[backup-uploader] upload hata: ${e.message}`);
			return false;
		}
	}

	_postMultipart(filename, fileBytes, content) {
		return new Promise((resolve, reject) => {
			const url = new URL(this.webhookUrl);
			const boundary = '----csbackup' + Date.now().toString(36);
			const payloadJson = JSON.stringify({ content });

			const head =
				`--${boundary}\r\n` +
				`Content-Disposition: form-data; name="payload_json"\r\n` +
				`Content-Type: application/json\r\n\r\n` +
				payloadJson + '\r\n' +
				`--${boundary}\r\n` +
				`Content-Disposition: form-data; name="files[0]"; filename="${filename}"\r\n` +
				`Content-Type: application/octet-stream\r\n\r\n`;
			const tail = `\r\n--${boundary}--\r\n`;

			const headBuf = Buffer.from(head, 'utf8');
			const tailBuf = Buffer.from(tail, 'utf8');
			const body = Buffer.concat([headBuf, fileBytes, tailBuf]);

			const req = https.request({
				method: 'POST',
				hostname: url.hostname,
				path: url.pathname + url.search,
				headers: {
					'Content-Type': `multipart/form-data; boundary=${boundary}`,
					'Content-Length': body.length
				},
				timeout: 30000
			}, res => {
				let buf = '';
				res.on('data', d => buf += d);
				res.on('end', () => {
					if (res.statusCode >= 200 && res.statusCode < 300) {
						resolve();
					} else {
						reject(new Error(`Discord ${res.statusCode}: ${buf.slice(0, 200)}`));
					}
				});
			});
			req.on('error', reject);
			req.on('timeout', () => { req.destroy(); reject(new Error('upload timeout 30s')); });
			req.write(body);
			req.end();
		});
	}

	async uploadNow() {
		return this.uploadLatest();
	}
}

module.exports = BackupUploader;

if (require.main === module) {
	const [, , cmd, inFile, outFile] = process.argv;
	if (cmd !== 'decrypt' || !inFile) {
		console.error('Kullanım: node web/backup-uploader.js decrypt <input.enc> [output]');
		process.exit(1);
	}
	require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
	const secret = process.env.BACKUP_ENCRYPTION_KEY || process.env.JWT_SECRET;
	if (!secret) { console.error('.env içinde BACKUP_ENCRYPTION_KEY veya JWT_SECRET olmalı'); process.exit(2); }
	try {
		const enc = fs.readFileSync(inFile);
		const dec = BackupUploader.decrypt(enc, secret);
		const dest = outFile || inFile.replace(/\.enc$/, '') || (inFile + '.decrypted');
		fs.writeFileSync(dest, dec);
		console.log(`✓ Deşifre edildi: ${dest} (${dec.length} byte)`);
	} catch (e) {
		console.error('Deşifre hatası:', e.message);
		process.exit(3);
	}
}
