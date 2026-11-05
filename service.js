const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch {}

let _secretOverrides = [];
try { _secretOverrides = require('./web/lib/secrets-merge')() || []; } catch (e) {
	console.warn('[secrets] merge failed:', e.message);
}

const { startWebServer } = require('./web/server');
const BotManager = require('./web/bot-manager');
const TransactionProcessor = require('./web/transaction-processor');
const HoursBoostManager = require('./web/hours-boost-manager');
const GroupJoinManager = require('./web/group-join-manager');
const { GamesatisManager } = require('./gamesatis-automation/manager');
const { HesapManager } = require('./hesap-automation/manager');
const ServerUpdateMonitor = require('./web/server-update-monitor');
const BackupUploader = require('./web/backup-uploader');
const SlotWatcher = require('./web/slot-watcher');
const SelfHealingDaemon = require('./web/self-healing-daemon');
const db = require('./web/database');

const botConfig = require('./config.json');
const accounts = require('./accounts.json');
const webConfig = require('./web/config.json');

const logger = {
	info:    (msg) => console.log(`\x1b[36m[INFO]\x1b[0m  ${new Date().toLocaleTimeString('tr-TR')} ${msg}`),
	success: (msg) => console.log(`\x1b[32m[OK]\x1b[0m    ${new Date().toLocaleTimeString('tr-TR')} ${msg}`),
	warn:    (msg) => console.log(`\x1b[33m[WARN]\x1b[0m  ${new Date().toLocaleTimeString('tr-TR')} ${msg}`),
	error:   (msg) => console.log(`\x1b[31m[ERROR]\x1b[0m ${new Date().toLocaleTimeString('tr-TR')} ${msg}`),
};

async function main() {
	console.log('');
	console.log('  ╔═══════════════════════════════════════╗');
	console.log('  ║       CS Commends                  ║');
	console.log('  ║       cscommends.com               ║');
	console.log('  ╚═══════════════════════════════════════╝');
	console.log('');

	if (_secretOverrides.length > 0) {
		logger.success(`${_secretOverrides.length} secret ENV'den override edildi: ${_secretOverrides.join(', ')}`);
	} else {
		logger.info('Secret override yok — tüm secret config.json default\'undan (dev mode)');
	}

	logger.info(`${accounts.length} hesap yüklendi`);
	logger.info(`Sunucu: ${botConfig.server.ip}:${botConfig.server.port || '27015'}`);

	const botManager = new BotManager(accounts, botConfig.server, logger, {
		steamApiKey: botConfig.steamApiKey,
		pipeline: botConfig.pipeline || {},
		proxyInsecureTls: !!(botConfig.proxy && botConfig.proxy.insecureTls)
	});

	const processor = new TransactionProcessor(botManager, logger, {
		pollInterval: botConfig.processorPollInterval || 5000,
		delayBetweenCommends: botConfig.delayBetweenCommends || 3000,
		maxRetries: botConfig.processorMaxRetries || 2,
		concurrency: botConfig.concurrency || 1,
		webhookUrl: botConfig.webhookUrl,
		discordWebhookFormat: true
	});

	const hoursManager = new HoursBoostManager(logger, {
		cryptoSecret: webConfig.jwtSecret
	});

	const groupManager = new GroupJoinManager(botManager, accounts, logger, {
		pollInterval: 5000
	});

	const gamesatis = new GamesatisManager(logger);

	let hesapProxy = null;
	try {
		const hesapProxiesData = require('./web/proxies.json');
		const proxyUrls = (hesapProxiesData && hesapProxiesData.proxies) || [];
		if (proxyUrls.length > 0) {
			const u = new URL(proxyUrls[0]);
			hesapProxy = {
				server: `${u.protocol}//${u.hostname}:${u.port}`,
				username: decodeURIComponent(u.username || ''),
				password: decodeURIComponent(u.password || '')
			};
		}
	} catch {}
	const hesap = new HesapManager({
		log: logger,
		proxy: hesapProxy,
		pollIntervalSec: 60
	});

	const server = await startWebServer({
		port: webConfig.port || 3000,
		botManager,
		transactionProcessor: processor,
		hoursManager,
		groupManager,
		gamesatis,
		hesap
	});

	const { app } = require('./web/server');
	if (app.locals.setupBotManagerSSE) {
		app.locals.setupBotManagerSSE();
		logger.success('BotManager SSE events bağlandı');
	}
	app.locals.botManager = botManager;
	app.locals.transactionProcessor = processor;

	await botManager.startAll();

	processor.start();
	logger.success('Transaction processor çalışıyor (on-demand bot bağlantısı aktif)');

	logger.warn('Hours Boost DEVRE DIŞI — resumeAll skip edildi, yeni session da oluşturulamaz');
	try { await hoursManager.shutdownAll(); } catch {}
	groupManager.start();
	logger.success('Group Join manager aktif (Hours Boost pasif)');

	try {
		const r = gamesatis.startPolling();
		if (r.started) {
			logger.success(`Gamesatis polling aktif (${r.intervalSec}s aralıkla — oturum yoksa admin paneli login tetiklemeli)`);
		}
	} catch (err) {
		logger.warn(`Gamesatis polling başlatılamadı: ${err.message}`);
	}

	const updateMonitor = new ServerUpdateMonitor(logger, {
		appId: 730,
		serverDir: process.env.CS2_SERVER_DIR || (botConfig.cs2Server && botConfig.cs2Server.dir),
		steamcmdPath: process.env.STEAMCMD_PATH || (botConfig.cs2Server && botConfig.cs2Server.steamcmdPath),
		batPath: process.env.CS2_START_SCRIPT || (botConfig.cs2Server && botConfig.cs2Server.startScript),
		serverPublicIp: botConfig.server.ip,
		serverPort: parseInt(botConfig.server.port, 10) || 27015,
		checkIntervalMs: (botConfig.cs2UpdateCheckMinutes || 15) * 60 * 1000,
		discordWebhook: botConfig.webhookUrl,
		db,
		transactionProcessor: processor
	});
	updateMonitor.start();
	app.locals.serverUpdateMonitor = updateMonitor;

	try {
		db.autoBackup(botConfig.backupIntervalHours || 6, botConfig.backupMaxKeep || 10);
		logger.success(`DB autoBackup başlatıldı (her ${botConfig.backupIntervalHours || 6}h, max ${botConfig.backupMaxKeep || 10} snapshot)`);
	} catch (e) {
		logger.error(`autoBackup başlatılamadı: ${e.message}`);
	}

	const backupUploader = new BackupUploader(logger, {
		webhookUrl: botConfig.backupWebhookUrl || botConfig.webhookUrl,
		intervalHours: botConfig.backupUploadHours || 24,
		gzip: true
	});
	backupUploader.start();
	app.locals.backupUploader = backupUploader;

	const slotWatcher = new SlotWatcher(logger, {
		threshold: botConfig.slotWatcherThreshold || 6,
		intervalMs: (botConfig.slotWatcherIntervalSec || 120) * 1000,
		getActiveTxCount: () => {
			try { return processor._activeTransactions ? processor._activeTransactions.size : 0; }
			catch { return 0; }
		}
	});
	slotWatcher.start();
	app.locals.slotWatcher = slotWatcher;

	const selfHealing = new SelfHealingDaemon({
		botManager,
		processor,
		db,
		logger,
		webhookUrl: botConfig.webhookUrl,
		serverUpdateMonitor: updateMonitor
	});
	selfHealing.start();
	app.locals.selfHealingDaemon = selfHealing;

	const maintenanceTimer = setInterval(() => {
		try { db.pruneOldAuditLog && db.pruneOldAuditLog(90); } catch {}
		try {
			const n = db.pruneExpiredJwtSessions && db.pruneExpiredJwtSessions();
			if (n) logger.info(`[maintenance] ${n} eski JWT session kaydı silindi`);
		} catch {}
	}, 6 * 60 * 60 * 1000);

	const shutdown = async () => {
		logger.info('Kapatılıyor...');
		updateMonitor.stop();
		backupUploader.stop();
		try { slotWatcher.stop(); } catch {}
		try { selfHealing.stop(); } catch {}
		clearInterval(maintenanceTimer);
		processor.stop();
		groupManager.stop();
		await hoursManager.shutdownAll();
		await botManager.stopAll();
		try { await gamesatis.shutdown(); } catch {}
		try { await hesap.shutdown(); } catch {}
		server.close();
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	console.log('');
	logger.success('Sistem hazır!');
	logger.info(`CS Commends panel: http://localhost:${webConfig.port || 3000}`);
	logger.info(`Admin panel: http://localhost:${webConfig.port || 3000}/admin`);
	logger.info(`Production: https://cscommends.com`);
	console.log('');
}

main().catch(err => {
	console.error('Fatal:', err.message);
	process.exit(1);
});
