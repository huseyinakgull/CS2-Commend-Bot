const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data.sqlite');
const BACKUPS_DIR = path.join(__dirname, 'backups');

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000');
db.pragma('mmap_size = 268435456');
db.pragma('temp_store = MEMORY');
db.pragma('foreign_keys = ON');

db.exec(`
	CREATE TABLE IF NOT EXISTS migrations (
		version INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		applied_at TEXT DEFAULT (datetime('now'))
	);
`);

const migrations = [
	{
		version: 1,
		name: 'initial_schema',
		sql: `
			CREATE TABLE IF NOT EXISTS codes (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				code TEXT UNIQUE NOT NULL,
				balance INTEGER NOT NULL DEFAULT 0,
				initial_balance INTEGER NOT NULL DEFAULT 0,
				is_used INTEGER DEFAULT 0,
				used_by_user_id INTEGER,
				created_at TEXT DEFAULT (datetime('now')),
				expires_at TEXT
			);

			CREATE TABLE IF NOT EXISTS users (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				code_id INTEGER NOT NULL REFERENCES codes(id),
				steam_id TEXT,
				steam_name TEXT,
				balance INTEGER NOT NULL DEFAULT 0,
				referral_code TEXT,
				created_at TEXT DEFAULT (datetime('now')),
				last_active TEXT DEFAULT (datetime('now'))
			);

			CREATE TABLE IF NOT EXISTS transactions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL REFERENCES users(id),
				steam_id TEXT NOT NULL,
				friendly INTEGER NOT NULL DEFAULT 0,
				teaching INTEGER NOT NULL DEFAULT 0,
				leader INTEGER NOT NULL DEFAULT 0,
				total INTEGER NOT NULL DEFAULT 0,
				progress INTEGER NOT NULL DEFAULT 0,
				status TEXT NOT NULL DEFAULT 'pending',
				created_at TEXT DEFAULT (datetime('now')),
				completed_at TEXT
			);

			CREATE INDEX IF NOT EXISTS idx_codes_code ON codes(code);
			CREATE INDEX IF NOT EXISTS idx_codes_is_used ON codes(is_used);
			CREATE INDEX IF NOT EXISTS idx_users_code_id ON users(code_id);
			CREATE INDEX IF NOT EXISTS idx_users_steam_id ON users(steam_id);
			CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
			CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
			CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
		`
	},
	{
		version: 2,
		name: 'audit_log_table',
		sql: `
			CREATE TABLE IF NOT EXISTS audit_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				action TEXT NOT NULL,
				actor TEXT NOT NULL DEFAULT 'system',
				target_id INTEGER,
				target_type TEXT,
				details TEXT,
				ip TEXT,
				created_at TEXT DEFAULT (datetime('now'))
			);

			CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
			CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor);
			CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target_type, target_id);
			CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
		`
	},
	{
		version: 3,
		name: 'settings_table',
		sql: `
			CREATE TABLE IF NOT EXISTS settings (
				key TEXT PRIMARY KEY,
				value TEXT,
				updated_at TEXT DEFAULT (datetime('now'))
			);
		`
	},
	{
		version: 4,
		name: 'sessions_table',
		sql: `
			CREATE TABLE IF NOT EXISTS sessions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL REFERENCES users(id),
				token_hash TEXT UNIQUE NOT NULL,
				ip TEXT,
				user_agent TEXT,
				created_at TEXT DEFAULT (datetime('now')),
				expires_at TEXT NOT NULL,
				is_active INTEGER DEFAULT 1
			);

			CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
			CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
			CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
			CREATE INDEX IF NOT EXISTS idx_sessions_is_active ON sessions(is_active);
		`
	},
	{
		version: 5,
		name: 'additional_indexes',
		sql: `
			CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
			CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active);
			CREATE INDEX IF NOT EXISTS idx_codes_expires_at ON codes(expires_at);
			CREATE INDEX IF NOT EXISTS idx_transactions_steam_id ON transactions(steam_id);
			CREATE INDEX IF NOT EXISTS idx_transactions_status_created ON transactions(status, created_at);
		`
	},
	{
		version: 6,
		name: 'users_banned_column',
		sql: `
			ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0;
		`
	},
	{
		version: 7,
		name: 'promo_codes_table',
		sql: `
			CREATE TABLE IF NOT EXISTS promo_codes (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				code TEXT UNIQUE NOT NULL,
				balance INTEGER NOT NULL DEFAULT 0,
				max_uses INTEGER NOT NULL DEFAULT 1,
				current_uses INTEGER NOT NULL DEFAULT 0,
				community_name TEXT,
				expires_at TEXT,
				is_active INTEGER DEFAULT 1,
				created_at TEXT DEFAULT (datetime('now'))
			);

			CREATE TABLE IF NOT EXISTS promo_redemptions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				promo_id INTEGER NOT NULL REFERENCES promo_codes(id),
				user_id INTEGER NOT NULL REFERENCES users(id),
				balance_given INTEGER NOT NULL,
				redeemed_at TEXT DEFAULT (datetime('now'))
			);

			CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code);
			CREATE INDEX IF NOT EXISTS idx_promo_codes_active ON promo_codes(is_active);
			CREATE INDEX IF NOT EXISTS idx_promo_redemptions_promo ON promo_redemptions(promo_id);
			CREATE INDEX IF NOT EXISTS idx_promo_redemptions_user ON promo_redemptions(user_id);
		`
	},
	{
		version: 8,
		name: 'free_commends_table',
		sql: `
			CREATE TABLE IF NOT EXISTS free_commends (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				steam_id TEXT NOT NULL,
				ip TEXT,
				transaction_id INTEGER,
				status TEXT NOT NULL DEFAULT 'pending',
				progress INTEGER NOT NULL DEFAULT 0,
				total INTEGER NOT NULL DEFAULT 20,
				created_at TEXT DEFAULT (datetime('now')),
				completed_at TEXT
			);

			CREATE UNIQUE INDEX IF NOT EXISTS idx_free_commends_steam_id ON free_commends(steam_id);
			CREATE INDEX IF NOT EXISTS idx_free_commends_status ON free_commends(status);
			CREATE INDEX IF NOT EXISTS idx_free_commends_ip ON free_commends(ip);
		`
	},
	{
		version: 9,
		name: 'multi_product_services',
		sql: `
			ALTER TABLE codes ADD COLUMN product_type TEXT NOT NULL DEFAULT 'commend';
			ALTER TABLE users ADD COLUMN product_type TEXT NOT NULL DEFAULT 'commend';

			CREATE INDEX IF NOT EXISTS idx_codes_product_type ON codes(product_type);
			CREATE INDEX IF NOT EXISTS idx_users_product_type ON users(product_type);

			CREATE TABLE IF NOT EXISTS hours_boost_sessions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL REFERENCES users(id),
				steam_username TEXT NOT NULL,
				steam_id64 TEXT,
				steam_persona TEXT,
				appid INTEGER NOT NULL DEFAULT 730,
				requested_hours INTEGER NOT NULL,
				hours_done REAL NOT NULL DEFAULT 0,
				credential_blob TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				last_error TEXT,
				started_at TEXT,
				last_tick TEXT,
				completed_at TEXT,
				created_at TEXT DEFAULT (datetime('now'))
			);

			CREATE INDEX IF NOT EXISTS idx_hours_user ON hours_boost_sessions(user_id);
			CREATE INDEX IF NOT EXISTS idx_hours_status ON hours_boost_sessions(status);
			CREATE INDEX IF NOT EXISTS idx_hours_created ON hours_boost_sessions(created_at);

			CREATE TABLE IF NOT EXISTS group_orders (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL REFERENCES users(id),
				group_id64 TEXT NOT NULL,
				group_vanity TEXT,
				group_name TEXT,
				group_avatar TEXT,
				requested_count INTEGER NOT NULL,
				joined_count INTEGER NOT NULL DEFAULT 0,
				status TEXT NOT NULL DEFAULT 'pending',
				last_error TEXT,
				started_at TEXT,
				completed_at TEXT,
				created_at TEXT DEFAULT (datetime('now'))
			);

			CREATE INDEX IF NOT EXISTS idx_group_user ON group_orders(user_id);
			CREATE INDEX IF NOT EXISTS idx_group_status ON group_orders(status);
			CREATE INDEX IF NOT EXISTS idx_group_gid ON group_orders(group_id64);

			CREATE TABLE IF NOT EXISTS group_memberships (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				order_id INTEGER NOT NULL REFERENCES group_orders(id),
				bot_username TEXT NOT NULL,
				bot_steam_id TEXT,
				group_id64 TEXT NOT NULL,
				result TEXT NOT NULL DEFAULT 'success',
				error TEXT,
				created_at TEXT DEFAULT (datetime('now'))
			);

			CREATE INDEX IF NOT EXISTS idx_gm_order ON group_memberships(order_id);
			CREATE INDEX IF NOT EXISTS idx_gm_bot_group ON group_memberships(bot_username, group_id64);
			CREATE INDEX IF NOT EXISTS idx_gm_group_bot ON group_memberships(group_id64, bot_username);
		`
	},
	{
		version: 10,
		name: 'reseller_system',
		sql: `
			CREATE TABLE IF NOT EXISTS resellers (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				username TEXT UNIQUE NOT NULL,
				password_hash TEXT NOT NULL,
				password_salt TEXT NOT NULL,
				display_name TEXT,
				contact TEXT,
				status TEXT NOT NULL DEFAULT 'active',

				limit_commend INTEGER NOT NULL DEFAULT 0,
				limit_hours   INTEGER NOT NULL DEFAULT 0,
				limit_group   INTEGER NOT NULL DEFAULT 0,

				usage_commend INTEGER NOT NULL DEFAULT 0,
				usage_hours   INTEGER NOT NULL DEFAULT 0,
				usage_group   INTEGER NOT NULL DEFAULT 0,
				usage_period  TEXT,

				total_commend INTEGER NOT NULL DEFAULT 0,
				total_hours   INTEGER NOT NULL DEFAULT 0,
				total_group   INTEGER NOT NULL DEFAULT 0,
				total_codes   INTEGER NOT NULL DEFAULT 0,

				tier TEXT NOT NULL DEFAULT 'standard',
				notes TEXT,
				last_login TEXT,
				created_at TEXT DEFAULT (datetime('now'))
			);

			CREATE INDEX IF NOT EXISTS idx_resellers_username ON resellers(username);
			CREATE INDEX IF NOT EXISTS idx_resellers_status ON resellers(status);

			CREATE TABLE IF NOT EXISTS reseller_sessions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				reseller_id INTEGER NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
				token_hash TEXT UNIQUE NOT NULL,
				ip TEXT,
				user_agent TEXT,
				created_at TEXT DEFAULT (datetime('now')),
				expires_at TEXT NOT NULL,
				revoked INTEGER NOT NULL DEFAULT 0
			);

			CREATE INDEX IF NOT EXISTS idx_rsess_reseller ON reseller_sessions(reseller_id);
			CREATE INDEX IF NOT EXISTS idx_rsess_token ON reseller_sessions(token_hash);
			CREATE INDEX IF NOT EXISTS idx_rsess_expires ON reseller_sessions(expires_at);

			CREATE TABLE IF NOT EXISTS reseller_audit (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				reseller_id INTEGER NOT NULL,
				action TEXT NOT NULL,
				details TEXT,
				ip TEXT,
				created_at TEXT DEFAULT (datetime('now'))
			);

			CREATE INDEX IF NOT EXISTS idx_raudit_reseller ON reseller_audit(reseller_id);
			CREATE INDEX IF NOT EXISTS idx_raudit_created ON reseller_audit(created_at);

			ALTER TABLE codes ADD COLUMN reseller_id INTEGER;
			CREATE INDEX IF NOT EXISTS idx_codes_reseller ON codes(reseller_id);
		`
	},
	{
		version: 11,
		name: 'reviews_system',
		sql: `
			CREATE TABLE IF NOT EXISTS reviews (
				id INTEGER PRIMARY KEY AUTOINCREMENT,

				transaction_id INTEGER UNIQUE REFERENCES transactions(id) ON DELETE SET NULL,
				free_commend_id INTEGER UNIQUE REFERENCES free_commends(id) ON DELETE SET NULL,

				user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
				steam_id TEXT NOT NULL,
				display_name TEXT,
				avatar_url TEXT,

				product_type TEXT NOT NULL,
				rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
				comment TEXT,

				status TEXT NOT NULL DEFAULT 'pending',
				admin_note TEXT,
				moderated_at TEXT,
				is_featured INTEGER NOT NULL DEFAULT 0,

				ip TEXT,
				user_agent TEXT,
				created_at TEXT DEFAULT (datetime('now')),

				CHECK ((transaction_id IS NOT NULL) OR (free_commend_id IS NOT NULL))
			);

			CREATE INDEX IF NOT EXISTS idx_reviews_status     ON reviews(status);
			CREATE INDEX IF NOT EXISTS idx_reviews_created    ON reviews(created_at);
			CREATE INDEX IF NOT EXISTS idx_reviews_tx         ON reviews(transaction_id);
			CREATE INDEX IF NOT EXISTS idx_reviews_fc         ON reviews(free_commend_id);
			CREATE INDEX IF NOT EXISTS idx_reviews_steam      ON reviews(steam_id);
			CREATE INDEX IF NOT EXISTS idx_reviews_pub_recent ON reviews(status, created_at DESC);
		`
	},
	{
		version: 12,
		name: 'reviews_hours_group_support',
		sql: `
			CREATE TABLE reviews_new (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				transaction_id   INTEGER UNIQUE REFERENCES transactions(id) ON DELETE SET NULL,
				free_commend_id  INTEGER UNIQUE REFERENCES free_commends(id) ON DELETE SET NULL,
				hours_session_id INTEGER UNIQUE REFERENCES hours_boost_sessions(id) ON DELETE SET NULL,
				group_order_id   INTEGER UNIQUE REFERENCES group_orders(id) ON DELETE SET NULL,
				user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
				steam_id TEXT NOT NULL,
				display_name TEXT,
				avatar_url TEXT,
				product_type TEXT NOT NULL,
				rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
				comment TEXT,
				status TEXT NOT NULL DEFAULT 'pending',
				admin_note TEXT,
				moderated_at TEXT,
				is_featured INTEGER NOT NULL DEFAULT 0,
				ip TEXT,
				user_agent TEXT,
				created_at TEXT DEFAULT (datetime('now')),
				CHECK (
					(transaction_id   IS NOT NULL) OR
					(free_commend_id  IS NOT NULL) OR
					(hours_session_id IS NOT NULL) OR
					(group_order_id   IS NOT NULL)
				)
			);

			INSERT INTO reviews_new (
				id, transaction_id, free_commend_id, user_id, steam_id, display_name, avatar_url,
				product_type, rating, comment, status, admin_note, moderated_at, is_featured,
				ip, user_agent, created_at
			)
			SELECT
				id, transaction_id, free_commend_id, user_id, steam_id, display_name, avatar_url,
				product_type, rating, comment, status, admin_note, moderated_at, is_featured,
				ip, user_agent, created_at
			FROM reviews;

			DROP TABLE reviews;
			ALTER TABLE reviews_new RENAME TO reviews;

			CREATE INDEX IF NOT EXISTS idx_reviews_status     ON reviews(status);
			CREATE INDEX IF NOT EXISTS idx_reviews_created    ON reviews(created_at);
			CREATE INDEX IF NOT EXISTS idx_reviews_tx         ON reviews(transaction_id);
			CREATE INDEX IF NOT EXISTS idx_reviews_fc         ON reviews(free_commend_id);
			CREATE INDEX IF NOT EXISTS idx_reviews_hs         ON reviews(hours_session_id);
			CREATE INDEX IF NOT EXISTS idx_reviews_go         ON reviews(group_order_id);
			CREATE INDEX IF NOT EXISTS idx_reviews_steam      ON reviews(steam_id);
			CREATE INDEX IF NOT EXISTS idx_reviews_pub_recent ON reviews(status, created_at DESC);
		`
	},
	{
		version: 13,
		name: 'hitl_challenges',
		sql: `
			CREATE TABLE IF NOT EXISTS hitl_challenges (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				type TEXT NOT NULL,
				source TEXT NOT NULL,
				prompt TEXT,
				screenshot_path TEXT,
				answer TEXT,
				status TEXT NOT NULL DEFAULT 'pending',
				metadata TEXT,
				created_at TEXT DEFAULT (datetime('now')),
				resolved_at TEXT,
				expires_at TEXT
			);

			CREATE INDEX IF NOT EXISTS idx_hitl_status     ON hitl_challenges(status);
			CREATE INDEX IF NOT EXISTS idx_hitl_pending    ON hitl_challenges(status, created_at) WHERE status = 'pending';
			CREATE INDEX IF NOT EXISTS idx_hitl_source     ON hitl_challenges(source);
		`
	},
	{
		version: 15,
		name: 'payments_table',
		sql: `
			CREATE TABLE IF NOT EXISTS payments (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				provider_invoice_id TEXT NOT NULL,
				provider_payment_id TEXT,
				package_id TEXT,
				balance_credit INTEGER NOT NULL,
				price_amount REAL NOT NULL,
				price_currency TEXT NOT NULL DEFAULT 'usd',
				pay_currency TEXT,
				pay_amount REAL,
				contact_email TEXT,
				generated_code_id INTEGER REFERENCES codes(id),
				code_generated INTEGER NOT NULL DEFAULT 0,
				status TEXT NOT NULL DEFAULT 'created',
				ip TEXT,
				user_agent TEXT,
				webhook_payload TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now')),
				completed_at TEXT
			);
			CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_invoice ON payments(provider, provider_invoice_id);
			CREATE INDEX IF NOT EXISTS idx_payments_status  ON payments(status);
			CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);
			CREATE INDEX IF NOT EXISTS idx_payments_generated_code ON payments(generated_code_id);
		`
	},
	{
		version: 14,
		name: 'jwt_user_sessions_table',
		sql: `
			CREATE TABLE IF NOT EXISTS jwt_user_sessions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				token_hash TEXT UNIQUE NOT NULL,
				subject_type TEXT NOT NULL,
				subject_id   INTEGER,
				ip TEXT,
				user_agent TEXT,
				issued_at TEXT NOT NULL DEFAULT (datetime('now')),
				expires_at TEXT NOT NULL,
				revoked INTEGER NOT NULL DEFAULT 0,
				revoked_at TEXT,
				revoke_reason TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_jus_token   ON jwt_user_sessions(token_hash);
			CREATE INDEX IF NOT EXISTS idx_jus_subject ON jwt_user_sessions(subject_type, subject_id);
			CREATE INDEX IF NOT EXISTS idx_jus_expires ON jwt_user_sessions(expires_at);
			CREATE INDEX IF NOT EXISTS idx_jus_revoked ON jwt_user_sessions(revoked);
		`
	},
	{
		version: 16,
		name: 'payments_access_token',
		sql: `
			ALTER TABLE payments ADD COLUMN access_token TEXT;
			CREATE INDEX IF NOT EXISTS idx_payments_access_token ON payments(access_token);
		`
	}
];

function _execIdempotent(sql, migrationName) {
	const statements = sql
		.replace(/^\s*--.*$/gm, '')
		.split(/;\s*\n/)
		.map(s => s.trim())
		.filter(Boolean);

	for (const stmt of statements) {
		try {
			db.exec(stmt + ';');
		} catch (err) {
			const msg = (err.message || '').toLowerCase();
			if (
				msg.includes('duplicate column name') ||
				msg.includes('already exists') ||
				(msg.includes('no such table') && /^\s*drop\s+table/i.test(stmt))
			) {
				console.log(`[database] M(${migrationName}) tolere: ${err.message.split('\n')[0]}`);
				continue;
			}
			throw err;
		}
	}
}

function runMigrations() {
	const applied = new Set(
		db.prepare('SELECT version FROM migrations').all().map(r => r.version)
	);

	const pending = migrations.filter(m => !applied.has(m.version));
	if (pending.length === 0) return;

	const insertMigration = db.prepare(
		'INSERT INTO migrations (version, name) VALUES (?, ?)'
	);

	const run = db.transaction(() => {
		for (const m of pending) {
			_execIdempotent(m.sql, m.name);
			insertMigration.run(m.version, m.name);
		}
	});

	run();
	console.log(`[database] Applied ${pending.length} migration(s): ${pending.map(m => m.name).join(', ')}`);
}

function pruneOldAuditLog(retentionDays = 90) {
	try {
		const r = db.prepare(`DELETE FROM audit_log WHERE created_at < datetime('now', ?)`).run(`-${retentionDays} days`);
		if (r.changes > 0) {
			console.log(`[database] Audit log pruned: ${r.changes} eski kayıt silindi (${retentionDays}+ gün)`);
		}
		return r.changes;
	} catch (e) {
		console.error('[database] pruneOldAuditLog hata:', e.message);
		return 0;
	}
}

runMigrations();

try {
	const { freelist_count } = db.prepare('PRAGMA freelist_count').get();
	const { page_count } = db.prepare('PRAGMA page_count').get();
	if (page_count > 0 && freelist_count / page_count > 0.2) {
		console.log('[database] Running VACUUM (freelist ratio exceeded 20%)...');
		db.exec('VACUUM');
	}
} catch (_) {
}

const stmts = {
	getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
	getUserByCode: db.prepare(`
		SELECT u.* FROM users u
		JOIN codes c ON u.code_id = c.id
		WHERE c.code = ?
	`),
	getUserBalance: db.prepare('SELECT balance FROM users WHERE id = ?'),
	deductBalance: db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?'),

	insertTransaction: db.prepare(`
		INSERT INTO transactions (user_id, steam_id, friendly, teaching, leader, total, status)
		VALUES (?, ?, ?, ?, ?, ?, 'pending')
	`),
	updateTransactionProgress: db.prepare(`
		UPDATE transactions
		SET progress = ?,
		    status = ?,
		    completed_at = CASE WHEN ? IN ('completed', 'failed') THEN datetime('now') ELSE completed_at END
		WHERE id = ?
	`),
	getActiveTransactions: db.prepare(`
		SELECT * FROM transactions
		WHERE status IN ('pending', 'processing')
		ORDER BY created_at ASC
	`),
	getActiveTransactionsByUser: db.prepare(`
		SELECT * FROM transactions
		WHERE user_id = ? AND status IN ('pending', 'processing')
		ORDER BY created_at ASC
	`),
	getPendingTransactions: db.prepare(`
		SELECT * FROM transactions
		WHERE status = 'pending'
		ORDER BY created_at ASC
		LIMIT ?
	`),

	insertAuditLog: db.prepare(`
		INSERT INTO audit_log (action, actor, target_id, target_type, details, ip)
		VALUES (?, ?, ?, ?, ?, ?)
	`),

	getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
	upsertSetting: db.prepare(`
		INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
	`),

	cleanupExpiredSessions: db.prepare(`
		UPDATE sessions SET is_active = 0
		WHERE is_active = 1 AND expires_at < datetime('now')
	`),

	statsTotalUsers: db.prepare('SELECT COUNT(*) AS count FROM users'),
	statsTotalCodes: db.prepare('SELECT COUNT(*) AS count FROM codes'),
	statsActiveCodes: db.prepare('SELECT COUNT(*) AS count FROM codes WHERE is_used = 0'),
	statsTotalTransactions: db.prepare('SELECT COUNT(*) AS count FROM transactions'),
	statsPendingTransactions: db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE status = 'pending'"),
	statsCompletedTransactions: db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE status = 'completed'"),
	statsFailedTransactions: db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE status = 'failed'"),
	statsTotalCommends: db.prepare('SELECT COALESCE(SUM(progress), 0) AS count FROM transactions'),
};

function getUser(userId) {
	return stmts.getUser.get(userId) || null;
}

function getUserByCode(code) {
	return stmts.getUserByCode.get(code) || null;
}

function createTransaction(userId, steamId, { friendly = 0, teaching = 0, leader = 0 } = {}) {
	const total = friendly + teaching + leader;
	if (total <= 0) throw new Error('Total commend count must be greater than 0');

	const txn = db.transaction(() => {
		const user = stmts.getUserBalance.get(userId);
		if (!user) throw new Error('User not found');
		if (user.balance < total) throw new Error('Insufficient balance');

		const changed = stmts.deductBalance.run(total, userId, total);
		if (changed.changes === 0) throw new Error('Balance deduction failed (race condition)');

		const result = stmts.insertTransaction.run(userId, steamId, friendly, teaching, leader, total);
		return db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid);
	});

	return txn();
}

function updateTransactionProgress(txId, progress, status = 'processing') {
	return stmts.updateTransactionProgress.run(progress, status, status, txId);
}

function getActiveTransactions(userId) {
	if (userId !== undefined && userId !== null) {
		return stmts.getActiveTransactionsByUser.all(userId);
	}
	return stmts.getActiveTransactions.all();
}

function getPendingTransactions(limit = 10) {
	return stmts.getPendingTransactions.all(limit);
}

function addAuditLog(action, actor = 'system', targetId = null, targetType = null, details = null, ip = null) {
	const detailsStr = details && typeof details === 'object' ? JSON.stringify(details) : details;
	return stmts.insertAuditLog.run(action, actor, targetId, targetType, detailsStr, ip);
}

function getSetting(key, defaultValue = null) {
	const row = stmts.getSetting.get(key);
	return row ? row.value : defaultValue;
}

function setSetting(key, value) {
	const valStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
	return stmts.upsertSetting.run(key, valStr);
}

function cleanupExpiredSessions() {
	return stmts.cleanupExpiredSessions.run();
}

function transitionTransactionStatus(txId, fromStatuses, toStatus, opts = {}) {
	if (!Array.isArray(fromStatuses) || fromStatuses.length === 0) {
		throw new Error('fromStatuses must be a non-empty array');
	}

	const placeholders = fromStatuses.map(() => '?').join(',');
	const updateSql = `
		UPDATE transactions
		SET status = ?,
		    completed_at = CASE WHEN ? IN ('completed','failed','cancelled','partial') THEN datetime('now') ELSE completed_at END,
		    error_type    = COALESCE(?, error_type),
		    error_message = COALESCE(?, error_message)
		WHERE id = ? AND status IN (${placeholders})
	`;

	const run = db.transaction(() => {
		const tx = db.prepare('SELECT id, user_id, total, progress, status FROM transactions WHERE id = ?').get(txId);
		if (!tx) return { changed: false, refunded: 0, previousStatus: null };

		const result = db.prepare(updateSql).run(
			toStatus, toStatus,
			opts.errorType || null,
			opts.errorMessage || null,
			txId, ...fromStatuses
		);
		if (result.changes === 0) {
			return { changed: false, refunded: 0, previousStatus: tx.status };
		}

		let refunded = 0;
		if (opts.refund) {
			const refund = Math.max(0, tx.total - tx.progress);
			if (refund > 0) {
				db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(refund, tx.user_id);
				refunded = refund;
			}
		}

		return { changed: true, refunded, previousStatus: tx.status };
	});

	return run();
}

function recordJwtSession(tokenHash, subjectType, subjectId, expiresAtIso, ip = null, userAgent = null) {
	try {
		db.prepare(`
			INSERT OR IGNORE INTO jwt_user_sessions (token_hash, subject_type, subject_id, ip, user_agent, expires_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`).run(tokenHash, subjectType, subjectId || null, ip, (userAgent || '').slice(0, 200), expiresAtIso);
	} catch (e) {  }
}

function isJwtRevoked(tokenHash) {
	try {
		const r = db.prepare('SELECT revoked FROM jwt_user_sessions WHERE token_hash = ?').get(tokenHash);
		return r ? !!r.revoked : false;
	} catch { return false; }
}

function revokeJwt(tokenHash, reason = 'logout') {
	try {
		const r = db.prepare(`
			UPDATE jwt_user_sessions
			SET revoked = 1, revoked_at = datetime('now'), revoke_reason = ?
			WHERE token_hash = ?
		`).run(reason, tokenHash);
		return r.changes > 0;
	} catch { return false; }
}

function revokeAllJwtForSubject(subjectType, subjectId, reason = 'admin_revoke') {
	try {
		const r = db.prepare(`
			UPDATE jwt_user_sessions
			SET revoked = 1, revoked_at = datetime('now'), revoke_reason = ?
			WHERE subject_type = ? AND subject_id = ? AND revoked = 0
		`).run(reason, subjectType, subjectId);
		return r.changes;
	} catch { return 0; }
}

function pruneExpiredJwtSessions() {
	try {
		const r = db.prepare(`DELETE FROM jwt_user_sessions WHERE expires_at < datetime('now', '-7 days')`).run();
		return r.changes;
	} catch { return 0; }
}

function getStats() {
	return {
		totalUsers: stmts.statsTotalUsers.get().count,
		totalCodes: stmts.statsTotalCodes.get().count,
		activeCodes: stmts.statsActiveCodes.get().count,
		totalTransactions: stmts.statsTotalTransactions.get().count,
		pendingTransactions: stmts.statsPendingTransactions.get().count,
		completedTransactions: stmts.statsCompletedTransactions.get().count,
		failedTransactions: stmts.statsFailedTransactions.get().count,
		totalCommends: stmts.statsTotalCommends.get().count,
	};
}

function backupDatabase(destPath) {
	if (!fs.existsSync(path.dirname(destPath))) {
		fs.mkdirSync(path.dirname(destPath), { recursive: true });
	}
	return db.backup(destPath);
}

let _autoBackupTimer = null;

function autoBackup(intervalHours = 6, maxBackups = 10) {
	if (_autoBackupTimer) {
		clearInterval(_autoBackupTimer);
		_autoBackupTimer = null;
	}

	if (!fs.existsSync(BACKUPS_DIR)) {
		fs.mkdirSync(BACKUPS_DIR, { recursive: true });
	}

	const performBackup = async () => {
		try {
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			const dest = path.join(BACKUPS_DIR, `data-${timestamp}.sqlite`);
			await backupDatabase(dest);
			console.log(`[database] Backup created: ${dest}`);

			const files = fs.readdirSync(BACKUPS_DIR)
				.filter(f => f.startsWith('data-') && f.endsWith('.sqlite'))
				.sort()
				.reverse();

			for (const old of files.slice(maxBackups)) {
				fs.unlinkSync(path.join(BACKUPS_DIR, old));
				console.log(`[database] Pruned old backup: ${old}`);
			}
		} catch (err) {
			console.error('[database] Backup failed:', err.message);
		}
	};

	performBackup();
	_autoBackupTimer = setInterval(performBackup, intervalHours * 60 * 60 * 1000);

	return _autoBackupTimer;
}

function stopAutoBackup() {
	if (_autoBackupTimer) {
		clearInterval(_autoBackupTimer);
		_autoBackupTimer = null;
	}
}

module.exports = db;

module.exports.db = db;
module.exports.getUser = getUser;
module.exports.getUserByCode = getUserByCode;
module.exports.createTransaction = createTransaction;
module.exports.updateTransactionProgress = updateTransactionProgress;
module.exports.getActiveTransactions = getActiveTransactions;
module.exports.getPendingTransactions = getPendingTransactions;
module.exports.addAuditLog = addAuditLog;
module.exports.getStats = getStats;
module.exports.transitionTransactionStatus = transitionTransactionStatus;
module.exports.getSetting = getSetting;
module.exports.setSetting = setSetting;
module.exports.cleanupExpiredSessions = cleanupExpiredSessions;
module.exports.backupDatabase = backupDatabase;
module.exports.autoBackup = autoBackup;
module.exports.stopAutoBackup = stopAutoBackup;
module.exports.runMigrations = runMigrations;
module.exports.pruneOldAuditLog = pruneOldAuditLog;
module.exports.recordJwtSession = recordJwtSession;
module.exports.isJwtRevoked = isJwtRevoked;
module.exports.revokeJwt = revokeJwt;
module.exports.revokeAllJwtForSubject = revokeAllJwtForSubject;
module.exports.pruneExpiredJwtSessions = pruneExpiredJwtSessions;
