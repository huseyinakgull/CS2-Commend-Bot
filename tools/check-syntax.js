const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'protobufs']);
const VENDORED = new Set([path.join('web', 'public', 'js', 'tailwind.js')]);

function collect(dir, out) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (SKIP.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) collect(full, out);
		else if (entry.name.endsWith('.js') && !VENDORED.has(path.relative(ROOT, full))) out.push(full);
	}
	return out;
}

let failed = 0;
const files = collect(ROOT, []);
for (const file of files) {
	try {
		execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
	} catch (err) {
		failed++;
		console.error(`${path.relative(ROOT, file)}\n${err.stderr || err.message}`);
	}
}
console.log(`${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
