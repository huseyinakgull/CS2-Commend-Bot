const TOKEN_RE = /__SERVER_(ADDR|PASSWORD)__/g;

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function configuredValues() {
	const config = require('../config.json');
	const server = (config.serverInfo || [])[0] || {};
	return { ADDR: server.ip || '', PASSWORD: server.password || '' };
}

// Pages and language files reference the public game server as tokens so the
// address and password come from web/config.json instead of being hard coded.
function applyServerTokens(text, format = 'html', values) {
	if (typeof text !== 'string' || !text.includes('__SERVER_')) return text;
	const v = values || configuredValues();
	return text.replace(TOKEN_RE, (_, key) => {
		const html = escapeHtml(v[key] || '');
		return format === 'json' ? JSON.stringify(html).slice(1, -1) : html;
	});
}

module.exports = { applyServerTokens };
