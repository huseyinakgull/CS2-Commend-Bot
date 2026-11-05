const startedAt = Date.now();

const state = {
	requests: {
		total: 0,
		byStatus: {},
		slowCount: 0,
		totalDurationMs: 0
	},
	commends: {
		attempts: 0,
		success: 0,
		failTimeout: 0,
		failTargetNotFound: 0,
		failRateLimited: 0,
		failOther: 0
	},
	transactions: {
		started: 0,
		completed: 0,
		failed: 0,
		cancelled: 0,
		partial: 0,
		refundedTotal: 0
	},
	cancelReasons: {},
	bots: {
		uniqueUsedLastHour: 0,
		cooldownActive: 0
	},
	gamesatis: {
		pollsTotal: 0,
		ordersDelivered: 0,
		sessionExpiredCount: 0
	},
	errors: {
		uncaughtCount: 0,
		lastError: null
	}
};

const RECENT_REQUESTS_MAX = 200;
const recentRequests = [];

function recordRequest(method, path, status, durationMs) {
	state.requests.total++;
	state.requests.byStatus[status] = (state.requests.byStatus[status] || 0) + 1;
	if (durationMs > 1000) state.requests.slowCount++;
	state.requests.totalDurationMs += durationMs;

	recentRequests.push({ ts: Date.now(), method, path, status, durationMs });
	if (recentRequests.length > RECENT_REQUESTS_MAX) recentRequests.shift();
}

function recordCommendAttempt(result, category) {
	state.commends.attempts++;
	if (result === 'success') state.commends.success++;
	else if (category === 'target_not_found') state.commends.failTargetNotFound++;
	else if (category === 'rate_limited') state.commends.failRateLimited++;
	else if (category === 'timeout') state.commends.failTimeout++;
	else state.commends.failOther++;
}

function recordTransaction(event, opts = {}) {
	if (event === 'started') state.transactions.started++;
	else if (event === 'completed') state.transactions.completed++;
	else if (event === 'failed') state.transactions.failed++;
	else if (event === 'cancelled') state.transactions.cancelled++;
	else if (event === 'partial') state.transactions.partial++;
	if (opts.refunded) state.transactions.refundedTotal += opts.refunded;
	if (opts.reason) {
		const r = String(opts.reason).slice(0, 64);
		state.cancelReasons[r] = (state.cancelReasons[r] || 0) + 1;
	}
}

function recordGamesatis(event) {
	if (event === 'poll')           state.gamesatis.pollsTotal++;
	if (event === 'delivered')      state.gamesatis.ordersDelivered++;
	if (event === 'session_expired') state.gamesatis.sessionExpiredCount++;
}

function recordError(message, stack = null) {
	state.errors.uncaughtCount++;
	state.errors.lastError = { ts: Date.now(), message: String(message).slice(0, 500), stack: stack ? String(stack).slice(0, 2000) : null };
}

function setBotStats({ uniqueUsedLastHour, cooldownActive }) {
	if (Number.isFinite(uniqueUsedLastHour)) state.bots.uniqueUsedLastHour = uniqueUsedLastHour;
	if (Number.isFinite(cooldownActive))     state.bots.cooldownActive = cooldownActive;
}

function getSnapshot() {
	const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
	const avgReqDurMs = state.requests.total > 0
		? Math.round(state.requests.totalDurationMs / state.requests.total)
		: 0;
	const successRate = state.commends.attempts > 0
		? Math.round((state.commends.success / state.commends.attempts) * 1000) / 10
		: null;
	const txTotal = state.transactions.completed + state.transactions.failed +
	                state.transactions.cancelled + state.transactions.partial;
	const txCompletionRate = txTotal > 0
		? Math.round((state.transactions.completed / txTotal) * 1000) / 10
		: null;

	return {
		uptimeSec,
		startedAt: new Date(startedAt).toISOString(),
		now: new Date().toISOString(),
		requests: {
			...state.requests,
			avgDurationMs: avgReqDurMs
		},
		commends: {
			...state.commends,
			successRatePct: successRate
		},
		transactions: {
			...state.transactions,
			completionRatePct: txCompletionRate
		},
		cancelReasons: state.cancelReasons,
		bots: state.bots,
		gamesatis: state.gamesatis,
		errors: state.errors
	};
}

function getRecentRequests(limit = 50) {
	return recentRequests.slice(-Math.min(limit, RECENT_REQUESTS_MAX));
}

function reset() {
	for (const k of Object.keys(state.requests.byStatus)) delete state.requests.byStatus[k];
	state.requests.total = 0;
	state.requests.slowCount = 0;
	state.requests.totalDurationMs = 0;
	for (const k of Object.keys(state.cancelReasons)) delete state.cancelReasons[k];
	state.commends.attempts = state.commends.success = state.commends.failTimeout = 0;
	state.commends.failTargetNotFound = state.commends.failRateLimited = state.commends.failOther = 0;
	state.transactions.started = state.transactions.completed = 0;
	state.transactions.failed = state.transactions.cancelled = state.transactions.partial = 0;
	state.transactions.refundedTotal = 0;
	state.gamesatis.pollsTotal = state.gamesatis.ordersDelivered = state.gamesatis.sessionExpiredCount = 0;
	state.errors.uncaughtCount = 0;
	state.errors.lastError = null;
	recentRequests.length = 0;
}

module.exports = {
	recordRequest,
	recordCommendAttempt,
	recordTransaction,
	recordGamesatis,
	recordError,
	setBotStats,
	getSnapshot,
	getRecentRequests,
	reset
};
