const Protobuf = require('protobufjs');
const fs = require('fs');
const path = require('path');

function loadProtos(groups) {
	const result = {};

	for (const group of groups) {
		const root = new Protobuf.Root();

		const files = typeof group.protos === 'string'
			? fs.readdirSync(group.protos)
				.filter(f => f.endsWith('.proto'))
				.map(f => path.join(group.protos, f))
			: group.protos;

		for (const file of files) {
			if (!fs.existsSync(file)) continue;
			try {
				root.loadSync(file, { keepCase: true });
			} catch {
			}
		}

		result[group.name] = root;
	}

	return result;
}

module.exports = loadProtos;
