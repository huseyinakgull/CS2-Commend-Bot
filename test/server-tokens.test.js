const test = require('node:test');
const assert = require('node:assert');
const { applyServerTokens } = require('../web/lib/server-tokens');

const values = { ADDR: '203.0.113.5:27015', PASSWORD: 'p<a>"ss' };

test('replaces tokens in html', () => {
	const out = applyServerTokens('connect __SERVER_ADDR__; password __SERVER_PASSWORD__', 'html', values);
	assert.strictEqual(out, 'connect 203.0.113.5:27015; password p&lt;a&gt;&quot;ss');
});

test('json output stays valid json', () => {
	const src = JSON.stringify({ k: 'connect __SERVER_ADDR__; password __SERVER_PASSWORD__' });
	const parsed = JSON.parse(applyServerTokens(src, 'json', values));
	assert.strictEqual(parsed.k, 'connect 203.0.113.5:27015; password p&lt;a&gt;&quot;ss');
});

test('text without tokens is returned unchanged', () => {
	assert.strictEqual(applyServerTokens('<p>hello</p>', 'html', values), '<p>hello</p>');
	assert.strictEqual(applyServerTokens(null, 'html', values), null);
});

test('missing values become empty strings', () => {
	assert.strictEqual(applyServerTokens('[__SERVER_PASSWORD__]', 'html', { ADDR: 'x' }), '[]');
});
