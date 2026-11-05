const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', 'data', 'processed-orders.json');

function _load() {
	try {
		const txt = fs.readFileSync(STORE_PATH, 'utf8');
		const data = JSON.parse(txt);
		return { orders: data.orders || {}, lastPoll: data.lastPoll || null };
	} catch {
		return { orders: {}, lastPoll: null };
	}
}

function _save(state) {
	const dir = path.dirname(STORE_PATH);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
}

function isProcessed(orderId) {
	if (!orderId) return false;
	const state = _load();
	return !!state.orders[orderId];
}

function recordOrder(orderId, payload) {
	if (!orderId) throw new Error('orderId gerekli');
	const state = _load();
	state.orders[orderId] = {
		...(state.orders[orderId] || {}),
		...payload,
		orderId,
		processedAt: state.orders[orderId]?.processedAt || new Date().toISOString(),
		updatedAt: new Date().toISOString()
	};
	_save(state);
}

function updateLastPoll() {
	const state = _load();
	state.lastPoll = new Date().toISOString();
	_save(state);
}

function getStats() {
	const state = _load();
	const orders = Object.values(state.orders);
	return {
		totalProcessed: orders.length,
		messageSent: orders.filter(o => o.messageSent).length,
		delivered: orders.filter(o => o.delivered).length,
		failed: orders.filter(o => o.error).length,
		lastPoll: state.lastPoll
	};
}

function listProcessed(limit = 50) {
	const state = _load();
	return Object.values(state.orders)
		.sort((a, b) => (b.processedAt || '').localeCompare(a.processedAt || ''))
		.slice(0, limit);
}

module.exports = { isProcessed, recordOrder, updateLastPoll, getStats, listProcessed, STORE_PATH };
