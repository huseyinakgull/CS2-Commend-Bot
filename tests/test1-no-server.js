const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const SteamID = require('steamid');
const path = require('path');
const loadProtos = require('./helpers/Protos');
const { fetchGCVersion } = require('./helpers/ServerValidation');

const accounts = require('./accounts.json');
const TARGET = process.argv[2];

if (!TARGET) {
	console.log('Kullanım: node test1-no-server.js <targetSteamID64>');
	process.exit(1);
}

const targetAccountId = new SteamID(TARGET).accountid;
const APP_ID = 730;
let GC_VERSION = 2000771;

const protos = loadProtos([
	{ name: 'cs2', protos: path.join(__dirname, 'protobufs', 'cs2') },
]);
const HelloMsg = protos.cs2.lookupType('CMsgClientHello');
const CommendMsg = protos.cs2.lookupType('CMsgGCCStrike15_v2_ClientCommendPlayer');
const ResponseMsg = protos.cs2.lookupType('CMsgGCCStrike15_v2_ClientReportResponse');

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg) { console.log(`[${new Date().toLocaleTimeString('tr-TR')}] ${msg}`); }

async function testBot(label, accountIndex, mode) {
	log(`\n${'='.repeat(50)}`);
	log(`${label} — Hesap: ${accounts[accountIndex].username} — Mod: ${mode}`);
	log(`${'='.repeat(50)}`);

	const account = accounts[accountIndex];
	const bot = new SteamUser({ autoRelogin: false });

	let commendResult = null;
	bot.on('receivedFromGC', (appid, type, body) => {
		if (appid !== APP_ID) return;
		if (type === 9122) {
			try {
				const r = ResponseMsg.toObject(ResponseMsg.decode(body), { defaults: true, longs: Number });
				commendResult = r;
				log(`  GC YANIT: tokens=${r.tokens}, response_result=${r.response_result}`);
			} catch (e) {
				log(`  GC YANIT parse hatası: ${e.message}`);
			}
		}
	});

	try {
		await new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error('Login timeout')), 30000);
			bot.logOn({
				accountName: account.username,
				password: account.password,
				twoFactorCode: (account.sharedSecret && account.sharedSecret.length > 5)
					? SteamTotp.getAuthCode(account.sharedSecret) : undefined
			});
			bot.once('loggedOn', () => { clearTimeout(t); resolve(); });
			bot.once('error', (err) => { clearTimeout(t); reject(err); });
		});
		log(`  Login OK: ${bot.steamID.getSteamID64()}`);
	} catch (e) {
		log(`  Login FAIL: ${e.message}`);
		return { mode, success: false, error: 'login_fail' };
	}

	try { await bot.requestFreeLicense(APP_ID); } catch {}

	if (mode === 'no_game') {
		log(`  Oyun başlatılmadı, direkt commend denenecek`);
		await wait(3000);
	} else {
		bot.gamesPlayed(APP_ID);
		await wait(3000);

		const helloPayload = HelloMsg.encode(HelloMsg.create({
			version: GC_VERSION, client_session_need: 1, client_launcher: 0, steam_launcher: 0
		})).finish();
		bot.sendToGC(APP_ID, 4006, {}, Buffer.from(helloPayload));

		const gotData = await new Promise((resolve) => {
			const t = setTimeout(() => resolve(false), 10000);
			const h = (appid, type) => {
				if (appid === APP_ID && type === 9110) { clearTimeout(t); bot.removeListener('receivedFromGC', h); resolve(true); }
			};
			bot.on('receivedFromGC', h);
		});
		log(`  GC AccountData: ${gotData ? 'OK' : 'TIMEOUT'}`);
	}

	if (mode === 'fake_server') {
		const fakeSteamID = '90284171300000000';
		log(`  Sahte serverSteamID ile bind: ${fakeSteamID}`);
		bot.gamesPlayed({ game_id: APP_ID, steam_id_gs: fakeSteamID });
		await wait(3000);

		const helloPayload2 = HelloMsg.encode(HelloMsg.create({
			version: GC_VERSION, client_session_need: 1, client_launcher: 0, steam_launcher: 0
		})).finish();
		bot.sendToGC(APP_ID, 4006, {}, Buffer.from(helloPayload2));
		await wait(3000);
	}

	const commendPayload = CommendMsg.encode(CommendMsg.create({
		account_id: targetAccountId,
		match_id: 0,
		commendation: { cmd_friendly: 1, cmd_teaching: 1, cmd_leader: 1 },
		tokens: 0
	})).finish();

	log(`  Commend gönderiliyor → target=${targetAccountId}`);
	bot.sendToGC(APP_ID, 9121, {}, Buffer.from(commendPayload));

	for (let w = 0; w < 20; w++) {
		await wait(500);
		if (commendResult) break;
	}

	bot.logOff();

	if (commendResult) {
		log(`  SONUÇ: GC yanıt verdi — tokens=${commendResult.tokens}`);
		return { mode, success: true, tokens: commendResult.tokens };
	} else {
		log(`  ✗ SONUÇ: 10s timeout — GC yanıt vermedi`);
		return { mode, success: false, error: 'timeout' };
	}
}

async function main() {
	const gcv = await fetchGCVersion(null, GC_VERSION);
	GC_VERSION = gcv;
	log(`GC Version: ${GC_VERSION}`);
	log(`Target: ${TARGET} (accountId=${targetAccountId})`);

	const results = [];

	results.push(await testBot('BOT A', 0, 'no_game'));
	await wait(2000);

	results.push(await testBot('BOT B', 1, 'game_only'));
	await wait(2000);

	results.push(await testBot('BOT C', 2, 'fake_server'));

	log(`\n${'='.repeat(50)}`);
	log(`ÖZET:`);
	log(`${'='.repeat(50)}`);
	for (const r of results) {
		const status = r.success ? `✓ BAŞARILI (tokens=${r.tokens})` : `✗ BAŞARISIZ (${r.error})`;
		log(`  ${r.mode.padEnd(15)} → ${status}`);
	}
	log(`\nEğer herhangi biri başarılıysa → sunucu binding gereksiz, rate limit bypass mümkün!`);

	process.exit(0);
}

main().catch(err => {
	log(`FATAL: ${err.message}`);
	process.exit(1);
});
