const crypto = require('crypto');

const SCRYPT_N    = 16384;
const SCRYPT_R    = 8;
const SCRYPT_P    = 1;
const HASH_LEN    = 64;
const SALT_LEN    = 16;

function hashPassword(password) {
	if (!password || typeof password !== 'string' || password.length < 4) {
		throw new Error('password_too_short');
	}
	if (password.length > 256) throw new Error('password_too_long');
	const salt = crypto.randomBytes(SALT_LEN).toString('hex');
	const hash = crypto.scryptSync(password, salt, HASH_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }).toString('hex');
	return { salt, hash };
}

function verifyPassword(password, salt, hash) {
	if (!password || !salt || !hash) return false;
	try {
		const computed = crypto.scryptSync(password, salt, HASH_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
		const stored = Buffer.from(hash, 'hex');
		if (computed.length !== stored.length) return false;
		return crypto.timingSafeEqual(computed, stored);
	} catch {
		return false;
	}
}

function safeEqual(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
	const ha = crypto.createHash('sha256').update(a).digest();
	const hb = crypto.createHash('sha256').update(b).digest();
	return crypto.timingSafeEqual(ha, hb);
}

module.exports = { hashPassword, verifyPassword, safeEqual };
