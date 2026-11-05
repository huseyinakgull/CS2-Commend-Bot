module.exports = function mergeSecretsFromEnv() {
	const path = require('path');
	const botCfg = require(path.join(__dirname, '..', '..', 'config.json'));
	const webCfg = require(path.join(__dirname, '..', 'config.json'));

	const overrides = [];

	if (process.env.STEAM_API_KEY) {
		botCfg.steamApiKey = process.env.STEAM_API_KEY;
		overrides.push('steamApiKey');
	}
	if (process.env.SERVER_RCON_PASSWORD && botCfg.server) {
		botCfg.server.password = process.env.SERVER_RCON_PASSWORD;
		overrides.push('server.password');
	}
	if (process.env.DISCORD_WEBHOOK_URL) {
		botCfg.webhookUrl = process.env.DISCORD_WEBHOOK_URL;
		overrides.push('webhookUrl');
	}
	if (process.env.BACKUP_WEBHOOK_URL) {
		botCfg.backupWebhookUrl = process.env.BACKUP_WEBHOOK_URL;
		overrides.push('backupWebhookUrl');
	}

	if (process.env.JWT_SECRET) {
		webCfg.jwtSecret = process.env.JWT_SECRET;
		overrides.push('jwtSecret');
	}
	if (process.env.JWT_SECRET_OLD) {
		webCfg.jwtSecretOld = process.env.JWT_SECRET_OLD;
		overrides.push('jwtSecretOld');
	}
	if (process.env.ADMIN_PASSWORD) {
		webCfg.adminPassword = process.env.ADMIN_PASSWORD;
		overrides.push('adminPassword');
	}
	if (process.env.DISCORD_CLIENT_SECRET && webCfg.discord) {
		webCfg.discord.clientSecret = process.env.DISCORD_CLIENT_SECRET;
		overrides.push('discord.clientSecret');
	}
	if (process.env.DISCORD_COOKIE_SECRET && webCfg.discord) {
		webCfg.discord.cookieSecret = process.env.DISCORD_COOKIE_SECRET;
		overrides.push('discord.cookieSecret');
	}

	if (process.env.NOWPAYMENTS_API_KEY) {
		webCfg.nowpaymentsApiKey = process.env.NOWPAYMENTS_API_KEY;
		overrides.push('nowpaymentsApiKey');
	}
	if (process.env.NOWPAYMENTS_IPN_SECRET) {
		webCfg.nowpaymentsIpnSecret = process.env.NOWPAYMENTS_IPN_SECRET;
		overrides.push('nowpaymentsIpnSecret');
	}
	if (process.env.PUBLIC_BASE_URL) {
		webCfg.publicBaseUrl = process.env.PUBLIC_BASE_URL;
		overrides.push('publicBaseUrl');
	}

	return overrides;
};
