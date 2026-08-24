import { Buffer } from 'node:buffer';
import { createSocket, type Socket as DgramSocket } from 'node:dgram';
import { writeFile, unlink } from 'node:fs/promises';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { buildDigestAuthorization, parseDigestChallenge } from './intelbras';

export type ClipRate = 1 | 2 | 4 | 8;

export type RtspResponse = {
	statusCode: number;
	statusText: string;
	headers: Record<string, string>;
	body: string;
};

export type RtspSdpTrack = {
	kind: string;
	payloadTypes: string[];
	attributes: string[];
	control: string | null;
	controlUrl: string;
};

type RtspClientAuth = {
	username: string;
	password: string;
};

export type ScaledPlaybackSession = {
	inputArgs: string[];
	actualRate: ClipRate;
	sdpPath: string;
	close: () => void;
};

type OpenScaledPlaybackOptions = {
	url: string;
	redactedUrl: string;
	username: string;
	password: string;
	rate: ClipRate;
	sdpDir: string;
};

const USER_AGENT = 'SkyfitGCT/1.0';
const CONNECT_TIMEOUT_MS = 5_000;
const RESPONSE_TIMEOUT_MS = 8_000;
const KEEPALIVE_MS = 20_000;

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
	return headers[name.toLowerCase()];
}

function withoutCredentials(input: string): string {
	const parsed = new URL(input);
	parsed.username = '';
	parsed.password = '';
	return parsed.toString();
}

function socketAddress(input: string) {
	const parsed = new URL(input);
	return {
		host: parsed.hostname,
		port: Number(parsed.port || 554),
		uri: withoutCredentials(input)
	};
}

export function parseScaleHeader(value: string | undefined): number | null {
	if (!value) return null;
	const rate = Number(value.trim());
	return Number.isFinite(rate) && rate > 0 ? rate : null;
}

export function parseRtspResponse(raw: string): RtspResponse {
	const [head = '', body = ''] = raw.split('\r\n\r\n');
	const lines = head.split('\r\n');
	const statusLine = lines[0] ?? '';
	const match = /^RTSP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/.exec(statusLine);
	if (!match) throw new Error('Resposta RTSP invalida.');

	const headers: Record<string, string> = {};
	for (const line of lines.slice(1)) {
		const separator = line.indexOf(':');
		if (separator < 0) continue;
		headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
	}

	return {
		statusCode: Number(match[1]),
		statusText: match[2]?.trim() ?? '',
		headers,
		body
	};
}

function parseRtspResponseFromBuffer(buffer: Buffer): { response: RtspResponse; bytesRead: number } | null {
	const headerEnd = buffer.indexOf('\r\n\r\n');
	if (headerEnd < 0) return null;
	const headerText = buffer.subarray(0, headerEnd + 4).toString('utf8');
	const headerResponse = parseRtspResponse(headerText);
	const contentLength = Number(headerValue(headerResponse.headers, 'content-length') ?? 0) || 0;
	const total = headerEnd + 4 + contentLength;
	if (buffer.length < total) return null;
	const raw = buffer.subarray(0, total).toString('utf8');
	return { response: parseRtspResponse(raw), bytesRead: total };
}

export function resolveRtspControlUrl(baseUri: string, control: string | null): string {
	if (!control || control === '*') return baseUri;
	if (/^rtsp:\/\//i.test(control)) return control;
	return `${baseUri.replace(/\/$/, '')}/${control.replace(/^\//, '')}`;
}

export function parseSdpTracks(sdp: string, baseUri: string): RtspSdpTrack[] {
	const tracks: RtspSdpTrack[] = [];
	let current: { kind: string; payloadTypes: string[]; attributes: string[] } | null = null;

	function pushCurrent() {
		if (!current) return;
		const control = current.attributes.find((line) => line.startsWith('a=control:'))?.slice('a=control:'.length) ?? null;
		tracks.push({
			kind: current.kind,
			payloadTypes: current.payloadTypes,
			attributes: current.attributes,
			control,
			controlUrl: resolveRtspControlUrl(baseUri, control)
		});
	}

	for (const rawLine of sdp.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith('m=')) {
			pushCurrent();
			const parts = line.slice(2).split(/\s+/);
			current = { kind: parts[0] ?? 'video', payloadTypes: parts.slice(3), attributes: [] };
			continue;
		}
		if (current) current.attributes.push(line);
	}
	pushCurrent();

	return tracks.filter((track) => track.payloadTypes.length > 0);
}

export function rewriteSdpForLocalRtp(sdp: string, tracks: Array<RtspSdpTrack & { rtpPort: number; rtcpPort: number }>): string {
	const sessionLines = sdp
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('m=') && !line.startsWith('a=control:') && !line.startsWith('c='));
	const output = [...sessionLines.filter((line) => !line.startsWith('t=')), 'c=IN IP4 127.0.0.1', 't=0 0'];

	for (const track of tracks) {
		output.push(`m=${track.kind} ${track.rtpPort} RTP/AVP ${track.payloadTypes.join(' ')}`);
		output.push(`a=rtcp:${track.rtcpPort}`);
		for (const attribute of track.attributes) {
			if (attribute.startsWith('a=control:')) continue;
			output.push(attribute);
		}
	}

	return `${output.join('\r\n')}\r\n`;
}

async function reserveUdpPort(): Promise<number> {
	const socket = createSocket('udp4');
	return await new Promise<number>((resolve, reject) => {
		const onError = (error: Error) => {
			socket.close();
			reject(error);
		};
		socket.once('error', onError);
		socket.bind(0, '127.0.0.1', () => {
			socket.off('error', onError);
			const address = socket.address();
			const port = typeof address === 'object' ? address.port : 0;
			socket.close(() => resolve(port));
		});
	});
}

function connectRtsp(host: string, port: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = new Socket();
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error('Tempo esgotado conectando ao DVR via RTSP.'));
		}, CONNECT_TIMEOUT_MS);
		socket.once('error', (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		socket.connect(port, host, () => {
			clearTimeout(timeout);
			socket.removeAllListeners('error');
			resolve(socket);
		});
	});
}

class RtspClient {
	private buffer = Buffer.alloc(0);
	private cseq = 1;
	private wakeReader: (() => void) | null = null;
	private rejectReader: ((error: Error) => void) | null = null;
	private closed = false;
	private relayStarted = false;
	private relayDraining = false;
	private readonly channelPorts = new Map<number, number>();
	private readonly udpSender: DgramSocket;
	private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
	private disposed = false;
	sessionId: string | null = null;

	constructor(
		private readonly socket: Socket,
		private readonly uri: string,
		private readonly auth: RtspClientAuth
	) {
		this.udpSender = createSocket('udp4');
		socket.on('data', (chunk) => {
			this.buffer = Buffer.concat([this.buffer, typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)]);
			if (this.relayStarted) this.drainRelayBuffer();
			this.wakeReader?.();
		});
		socket.on('error', (error) => this.rejectReader?.(error));
		socket.on('close', () => {
			this.closed = true;
			this.wakeReader?.();
		});
	}

	close() {
		if (this.disposed) return;
		this.disposed = true;
		if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
		try {
			this.udpSender.close();
		} catch {
			// Already closed.
		}
		try {
			this.socket.destroy();
		} catch {
			// Already closed.
		}
	}

	mapChannel(channel: number, port: number) {
		this.channelPorts.set(channel, port);
	}

	private waitForData(timeoutMs = RESPONSE_TIMEOUT_MS): Promise<void> {
		if (this.buffer.length > 0 || this.closed) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.wakeReader = null;
				this.rejectReader = null;
				reject(new Error('Tempo esgotado aguardando resposta RTSP do DVR.'));
			}, timeoutMs);
			this.wakeReader = () => {
				clearTimeout(timeout);
				this.wakeReader = null;
				this.rejectReader = null;
				resolve();
			};
			this.rejectReader = (error) => {
				clearTimeout(timeout);
				this.wakeReader = null;
				this.rejectReader = null;
				reject(error);
			};
		});
	}

	private async readResponse(): Promise<RtspResponse> {
		while (true) {
			if (this.buffer[0] === 0x24) {
				if (this.buffer.length < 4) await this.waitForData();
				const length = this.buffer.readUInt16BE(2);
				if (this.buffer.length < length + 4) await this.waitForData();
				if (this.buffer.length >= length + 4) this.buffer = this.buffer.subarray(length + 4);
				continue;
			}

			const responseStart = this.buffer.indexOf('RTSP/');
			if (responseStart > 0) this.buffer = this.buffer.subarray(responseStart);
			const parsed = parseRtspResponseFromBuffer(this.buffer);
			if (parsed) {
				this.buffer = this.buffer.subarray(parsed.bytesRead);
				return parsed.response;
			}
			if (this.closed) throw new Error('Conexao RTSP encerrada pelo DVR.');
			await this.waitForData();
		}
	}

	private async sendRaw(method: string, requestUri: string, headers: Record<string, string> = {}): Promise<RtspResponse> {
		const lines = [
			`${method} ${requestUri} RTSP/1.0`,
			`CSeq: ${this.cseq++}`,
			`User-Agent: ${USER_AGENT}`,
			...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
			'',
			''
		];
		this.socket.write(lines.join('\r\n'));
		return await this.readResponse();
	}

	private authorization(method: string, requestUri: string, challengeHeader: string | undefined): string | null {
		if (!challengeHeader) return null;
		if (/^Basic/i.test(challengeHeader)) {
			return `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password}`).toString('base64')}`;
		}
		const challenge = parseDigestChallenge(challengeHeader);
		if (!challenge) return null;
		return buildDigestAuthorization({
			username: this.auth.username,
			password: this.auth.password,
			method,
			uri: requestUri,
			challenge
		});
	}

	async request(method: string, requestUri: string, headers: Record<string, string> = {}): Promise<RtspResponse> {
		let response = await this.sendRaw(method, requestUri, headers);
		if (response.statusCode !== 401) return response;

		const authHeader = this.authorization(method, requestUri, headerValue(response.headers, 'www-authenticate'));
		if (!authHeader) return response;
		response = await this.sendRaw(method, requestUri, { ...headers, Authorization: authHeader });
		return response;
	}

	startRelay() {
		this.relayStarted = true;
		this.drainRelayBuffer();
		this.keepaliveTimer = setInterval(() => {
			if (!this.sessionId) return;
			const lines = [
				`GET_PARAMETER ${this.uri} RTSP/1.0`,
				`CSeq: ${this.cseq++}`,
				`User-Agent: ${USER_AGENT}`,
				`Session: ${this.sessionId}`,
				'',
				''
			];
			this.socket.write(lines.join('\r\n'));
		}, KEEPALIVE_MS);
	}

	private drainRelayBuffer() {
		if (this.relayDraining) return;
		this.relayDraining = true;
		void (async () => {
			try {
				while (this.relayStarted && this.buffer.length > 0) {
					if (this.buffer[0] === 0x24) {
						if (this.buffer.length < 4) break;
						const channel = this.buffer[1] ?? 0;
						const length = this.buffer.readUInt16BE(2);
						if (this.buffer.length < length + 4) break;
						const payload = this.buffer.subarray(4, 4 + length);
						this.buffer = this.buffer.subarray(4 + length);
						const port = this.channelPorts.get(channel);
						if (port) await this.udpSender.send(payload, port, '127.0.0.1');
						continue;
					}

					const parsed = parseRtspResponseFromBuffer(this.buffer);
					if (parsed) {
						this.buffer = this.buffer.subarray(parsed.bytesRead);
						continue;
					}
					break;
				}
			} finally {
				this.relayDraining = false;
				if (this.relayStarted && this.buffer.length >= 4 && this.buffer[0] === 0x24) this.drainRelayBuffer();
			}
		})();
	}
}

function parseSessionId(value: string | undefined): string | null {
	if (!value) return null;
	return value.split(';')[0]?.trim() || null;
}

function isAcceptedRate(requested: ClipRate, response: RtspResponse): boolean {
	if (response.statusCode !== 200) return false;
	const accepted = parseScaleHeader(headerValue(response.headers, 'scale'));
	return accepted === null || accepted + 0.01 >= requested;
}

export async function openScaledPlayback(opts: OpenScaledPlaybackOptions): Promise<ScaledPlaybackSession | null> {
	if (opts.rate === 1) return null;
	const { host, port, uri } = socketAddress(opts.url);
	const socket = await connectRtsp(host, port);
	const client = new RtspClient(socket, uri, { username: opts.username, password: opts.password });
	let sdpPath: string | null = null;

	try {
		await client.request('OPTIONS', uri);
		const describe = await client.request('DESCRIBE', uri, { Accept: 'application/sdp' });
		if (describe.statusCode !== 200 || !describe.body.trim()) return null;

		const contentBase = headerValue(describe.headers, 'content-base') ?? headerValue(describe.headers, 'content-location') ?? uri;
		const tracks = parseSdpTracks(describe.body, contentBase);
		if (tracks.length === 0) return null;

		const localTracks: Array<RtspSdpTrack & { rtpPort: number; rtcpPort: number; rtpChannel: number; rtcpChannel: number }> = [];
		for (let index = 0; index < tracks.length; index += 1) {
			const track = tracks[index]!;
			const rtpChannel = index * 2;
			const rtcpChannel = rtpChannel + 1;
			const rtpPort = await reserveUdpPort();
			const rtcpPort = await reserveUdpPort();
			const setupHeaders: Record<string, string> = {
				Transport: `RTP/AVP/TCP;unicast;interleaved=${rtpChannel}-${rtcpChannel}`
			};
			if (client.sessionId) setupHeaders.Session = client.sessionId;
			const setup = await client.request('SETUP', track.controlUrl, setupHeaders);
			if (setup.statusCode !== 200) return null;
			client.sessionId = parseSessionId(headerValue(setup.headers, 'session')) ?? client.sessionId;
			client.mapChannel(rtpChannel, rtpPort);
			client.mapChannel(rtcpChannel, rtcpPort);
			localTracks.push({ ...track, rtpPort, rtcpPort, rtpChannel, rtcpChannel });
		}

		if (!client.sessionId) return null;
		sdpPath = join(opts.sdpDir, `${crypto.randomUUID()}.scaled.sdp`);
		await writeFile(sdpPath, rewriteSdpForLocalRtp(describe.body, localTracks), 'utf8');

		const play = await client.request('PLAY', uri, {
			Session: client.sessionId,
			Range: 'npt=0-',
			Scale: String(opts.rate)
		});
		if (!isAcceptedRate(opts.rate, play)) return null;
		client.startRelay();

		return {
			inputArgs: ['-protocol_whitelist', 'file,udp,rtp', '-f', 'sdp', '-i', sdpPath],
			actualRate: opts.rate,
			sdpPath,
			close: () => {
				client.close();
				void unlink(sdpPath!).catch(() => undefined);
			}
		};
	} catch (error) {
		console.warn(`[video] RTSP Scale indisponivel para ${opts.redactedUrl}: ${error instanceof Error ? error.message : error}`);
		return null;
	} finally {
		if (!sdpPath) {
			client.close();
		}
		await delay(0);
	}
}
