const net = require('net');

const SERVERDATA_AUTH = 3;
const SERVERDATA_AUTH_RESPONSE = 2;
const SERVERDATA_EXECCOMMAND = 2;
const SERVERDATA_RESPONSE_VALUE = 0;

class Rcon {
	constructor(host, port, password) {
		this.host = host;
		this.port = port;
		this.password = password;
		this.socket = null;
		this._requestId = 0;
		this._callbacks = new Map();
	}

	connect(timeoutMs = 10000) {
		return new Promise((resolve, reject) => {
			let settled = false;
			const fail = (err) => {
				if (settled) return;
				settled = true;
				if (this.socket) { try { this.socket.destroy(); } catch {} this.socket = null; }
				reject(err);
			};

			const timer = setTimeout(() => fail(new Error(`RCON connect timeout (${timeoutMs}ms)`)), timeoutMs);

			this.socket = net.createConnection(this.port, this.host, () => {
				const authId = this._requestId + 1;
				this._send(SERVERDATA_AUTH, this.password, (response) => {
					if (settled) return;
					if (response.type !== SERVERDATA_AUTH_RESPONSE) return;
					clearTimeout(timer);
					settled = true;
					this._callbacks.delete(authId);
					if (response.id === -1) {
						reject(new Error('RCON auth failed'));
					} else {
						resolve();
					}
				});
			});

			this.socket.on('error', (err) => { clearTimeout(timer); fail(err); });
			this.socket.on('close', () => {
				this.socket = null;
			});

			let buf = Buffer.alloc(0);
			this.socket.on('data', (data) => {
				buf = Buffer.concat([buf, data]);

				while (buf.length >= 4) {
					const size = buf.readInt32LE(0);
					if (buf.length < size + 4) break;

					const id = buf.readInt32LE(4);
					const type = buf.readInt32LE(8);
					const body = buf.slice(12, 4 + size - 2).toString('utf8');

					buf = buf.slice(4 + size);

					const cb = this._callbacks.get(id);
					if (cb) {
						cb({ id, type, body });
					}

				}
			});
		});
	}

	execute(command) {
		return new Promise((resolve, reject) => {
			if (!this.socket) {
				return reject(new Error('Not connected'));
			}

			const hardTimeout = setTimeout(() => {
				this._callbacks.delete(cmdId);
				reject(new Error('RCON timeout'));
			}, 10000);

			const cmdId = ++this._requestId;
			let buffered = '';
			let quietTimer = null;
			let resolved = false;

			const finish = () => {
				if (resolved) return;
				resolved = true;
				clearTimeout(hardTimeout);
				if (quietTimer) clearTimeout(quietTimer);
				this._callbacks.delete(cmdId);
				resolve(buffered);
			};

			this._callbacks.set(cmdId, (response) => {
				buffered += response.body;
				if (quietTimer) clearTimeout(quietTimer);
				quietTimer = setTimeout(finish, 400);
			});

			quietTimer = setTimeout(finish, 1500);

			this._sendRaw(cmdId, SERVERDATA_EXECCOMMAND, command);
		});
	}

	_sendRaw(id, type, body) {
		const bodyBuf = Buffer.from(body, 'utf8');
		const packet = Buffer.alloc(14 + bodyBuf.length);
		packet.writeInt32LE(10 + bodyBuf.length, 0);
		packet.writeInt32LE(id, 4);
		packet.writeInt32LE(type, 8);
		bodyBuf.copy(packet, 12);
		packet.writeInt16LE(0, 12 + bodyBuf.length);
		this.socket.write(packet);
	}

	_send(type, body, callback) {
		const id = ++this._requestId;
		const bodyBuf = Buffer.from(body, 'utf8');
		const packet = Buffer.alloc(14 + bodyBuf.length);

		packet.writeInt32LE(10 + bodyBuf.length, 0);
		packet.writeInt32LE(id, 4);
		packet.writeInt32LE(type, 8);
		bodyBuf.copy(packet, 12);
		packet.writeInt16LE(0, 12 + bodyBuf.length);

		if (callback) {
			this._callbacks.set(id, callback);
		}

		this.socket.write(packet);
	}

	disconnect() {
		if (this.socket) {
			this.socket.destroy();
			this.socket = null;
		}
	}
}

module.exports = Rcon;
