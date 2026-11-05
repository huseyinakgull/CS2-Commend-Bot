const db = require('../database');

function isMaintenance() {
	try {
		return db.getSetting('maintenance_mode', '0') === '1';
	} catch {
		return false;
	}
}

function maintenanceMessage() {
	try {
		return db.getSetting(
			'maintenance_message',
			'Sistem geçici olarak bakımda — kısa süre içinde tekrar dene.'
		);
	} catch {
		return 'Sistem geçici olarak bakımda — kısa süre içinde tekrar dene.';
	}
}

function blockIfMaintenance(req, res, next) {
	if (isMaintenance()) {
		return res.status(503).json({
			error: 'maintenance_mode',
			message: maintenanceMessage(),
			retryLater: true
		});
	}
	next();
}

module.exports = {
	isMaintenance,
	maintenanceMessage,
	blockIfMaintenance
};
