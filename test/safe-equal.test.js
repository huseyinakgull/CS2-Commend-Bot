const test = require('node:test');
const assert = require('node:assert');
const { safeEqual, hashPassword, verifyPassword } = require('../web/lib/password');

test('safeEqual matches identical strings only', () => {
	assert.strictEqual(safeEqual('secret', 'secret'), true);
	assert.strictEqual(safeEqual('secret', 'secreT'), false);
	assert.strictEqual(safeEqual('short', 'a much longer value'), false);
});

test('safeEqual rejects empty and non-string input', () => {
	assert.strictEqual(safeEqual('', ''), false);
	assert.strictEqual(safeEqual(undefined, 'x'), false);
	assert.strictEqual(safeEqual('x', null), false);
	assert.strictEqual(safeEqual(123, '123'), false);
});

test('hashPassword output verifies', () => {
	const { salt, hash } = hashPassword('correct horse');
	assert.strictEqual(verifyPassword('correct horse', salt, hash), true);
	assert.strictEqual(verifyPassword('wrong horse', salt, hash), false);
});
