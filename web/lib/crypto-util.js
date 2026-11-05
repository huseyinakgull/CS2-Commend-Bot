const crypto = require('crypto');

const LEGACY_SALT = 'hours-boost-v1';
const V2_PREFIX = 'v2';
const SALT_BYTES = 16;
const IV_BYTES = 12;

function deriveKey(secret, saltBytes) {
	const safeSecret = secret || 'default-insecure-key';
	return crypto.scryptSync(safeSecret, saltBytes, 32);
}

function encrypt(plaintextStr, secret) {
	if (typeof plaintextStr !== 'string') plaintextStr = JSON.stringify(plaintextStr);
	const salt = crypto.randomBytes(SALT_BYTES);
	const iv = crypto.randomBytes(IV_BYTES);
	const key = deriveKey(secret, salt);
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
	const ct = Buffer.concat([cipher.update(plaintextStr, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [
		V2_PREFIX,
		salt.toString('hex'),
		iv.toString('hex'),
		tag.toString('hex'),
		ct.toString('hex')
	].join('.');
}

function decrypt(blob, secret) {
	if (!blob || typeof blob !== 'string') throw new Error('invalid blob');
	const parts = blob.split('.');

	if (parts.length === 5 && parts[0] === V2_PREFIX) {
		const [, saltHex, ivHex, tagHex, ctHex] = parts;
		const salt = Buffer.from(saltHex, 'hex');
		const iv = Buffer.from(ivHex, 'hex');
		const tag = Buffer.from(tagHex, 'hex');
		const ct = Buffer.from(ctHex, 'hex');
		const key = deriveKey(secret, salt);
		const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
		decipher.setAuthTag(tag);
		const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
		return pt.toString('utf8');
	}

	if (parts.length === 3) {
		const [ivHex, tagHex, ctHex] = parts;
		const key = deriveKey(secret, LEGACY_SALT);
		const iv = Buffer.from(ivHex, 'hex');
		const tag = Buffer.from(tagHex, 'hex');
		const ct = Buffer.from(ctHex, 'hex');
		const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
		decipher.setAuthTag(tag);
		const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
		return pt.toString('utf8');
	}

	throw new Error('malformed blob (expected v2.salt.iv.tag.ct or iv.tag.ct)');
}

function encryptJson(obj, secret) {
	return encrypt(JSON.stringify(obj), secret);
}

function decryptJson(blob, secret) {
	return JSON.parse(decrypt(blob, secret));
}

function reencryptIfLegacy(blob, secret) {
	if (!blob || typeof blob !== 'string') return null;
	const parts = blob.split('.');
	if (parts.length === 5 && parts[0] === V2_PREFIX) return null;
	const plaintext = decrypt(blob, secret);
	return encrypt(plaintext, secret);
}

module.exports = {
	encrypt,
	decrypt,
	encryptJson,
	decryptJson,
	reencryptIfLegacy
};
