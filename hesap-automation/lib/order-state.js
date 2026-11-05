const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'data', 'order-state.json');

let _state = { processed: {}, lastPoll: null };

function _load() {
	try {
		if (fs.existsSync(STATE_PATH)) {
			_state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
			if (!_state.processed) _state.processed = {};
		}
	} catch (err) {
		console.warn('[hesap-order-state] yükleme hatası:', err.message);
		_state = { processed: {}, lastPoll: null };
	}
}

function _save() {
	try {
		fs.writeFileSync(STATE_PATH, JSON.stringify(_state, null, 2));
	} catch (err) {
		console.warn('[hesap-order-state] kaydetme hatası:', err.message);
	}
}

_load();

function isProcessed(orderId) {
	return !!_state.processed[orderId];
}

function markProcessed(orderId, info = {}) {
	_state.processed[orderId] = { at: new Date().toISOString(), ...info };
	_save();
}

function updateLastPoll() {
	_state.lastPoll = new Date().toISOString();
	_save();
}

function getStats() {
	const ids = Object.keys(_state.processed);
	return {
		total: ids.length,
		lastPoll: _state.lastPoll,
		recent: ids.slice(-5)
	};
}

function listProcessed(limit = 50) {
	const entries = Object.entries(_state.processed);
	return entries.slice(-limit).map(([id, info]) => ({ orderId: id, ...info }));
}

module.exports = {
	isProcessed, markProcessed, updateLastPoll, getStats, listProcessed
};
