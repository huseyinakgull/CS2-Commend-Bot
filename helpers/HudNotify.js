const Rcon = require('./Rcon');

async function _send(serverConfig, command, args) {
	if (!serverConfig?.ip || !serverConfig?.password) return;
	const port = parseInt(serverConfig.port || '27015');
	const rcon = new Rcon(serverConfig.rconIp || serverConfig.ip, port, serverConfig.password);
	try {
		await rcon.connect(5000);
		await rcon.execute(`${command} ${args.join(' ')}`);
	} catch {
	} finally {
		try { rcon.disconnect(); } catch {}
	}
}

async function notifyStarted(serverConfig, steamId64, total, orderId = '') {
	return _send(serverConfig, 'css_show_started', [steamId64, total, orderId]);
}

async function notifyProgress(serverConfig, steamId64, current, total) {
	return _send(serverConfig, 'css_show_progress', [steamId64, current, total]);
}

async function notifyDone(serverConfig, steamId64, success, total) {
	return _send(serverConfig, 'css_show_done', [steamId64, success, total]);
}

async function notifyClear(serverConfig, steamId64) {
	return _send(serverConfig, 'css_show_clear', [steamId64]);
}

module.exports = { notifyStarted, notifyProgress, notifyDone, notifyClear };
