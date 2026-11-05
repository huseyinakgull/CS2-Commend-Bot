const INVALID_SERVER_STEAMID = '72057594037927936';

function validateServerSteamID(steamId) {
	if (!steamId) {
		return { valid: false, reason: 'Server SteamID alınamadı (status komutu başarısız)' };
	}

	const sid = BigInt(steamId);

	const accountId = Number(sid & 0xFFFFFFFFn);
	const accountType = Number((sid >> 52n) & 0xFn);
	const universe = Number((sid >> 56n) & 0xFFn);

	if (universe === 0) {
		return { valid: false, reason: `Server SteamID geçersiz: Universe=0 (SteamID: ${steamId})` };
	}

	if (accountType === 0) {
		return {
			valid: true,
			warning: `Server GSLT'siz çalışıyor (Type=0). Map change ile rate limit bypass aktif.`
		};
	}

	return { valid: true };
}

async function fetchGCVersion(logger, currentVersion = 2000771) {
	try {
		const CS2 = require('node-cs2');
		const version = await CS2.fetchGCVersion();
		if (version && version > 0) {
			if (version !== currentVersion && logger) {
				logger.info(`GC Version güncellendi: ${currentVersion} → ${version}`);
			}
			return version;
		}
	} catch (err) {
		if (logger) {
			logger.warn(`GC version alınamadı: ${err.message} — mevcut kullanılıyor: ${currentVersion}`);
		}
	}
	return currentVersion;
}

module.exports = { validateServerSteamID, fetchGCVersion, INVALID_SERVER_STEAMID };
