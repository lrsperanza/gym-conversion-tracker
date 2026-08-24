import { Buffer } from 'node:buffer';
import { createServer, Socket, type Server } from 'node:net';
import { buildDigestAuthorization, parseDigestChallenge } from './intelbras';

export type ClipRate = 1 | 2 | 4 | 8;

export const CLIP_RATES: ClipRate[] = [1, 2, 4, 8];

export type RtspResponse = {
	statusCode: number;
	statusText: string;
	headers: Record<string, string>;
	body: string;
};

export type RtspSdpTrack = {
	kind: string;
	payloadTypes: string[];
	control: string | null;
	controlUrl: string;
};

export type ScaledRtspProxy = {
	url: string;
	redactedUrl: string;
	rate: ClipRate;
	close: () => void;
};

type ProbeOptions = {
	url: string;
	redactedUrl: string;
	username: string;
	password: string;
	rate: ClipRate;
};

const USER_AGENT = 'SkyfitGCT/1.0';
const CONNECT_TIMEOUT_MS = 5_000;
const RESPONSE_TIMEOUT_MS = 8_000;

function headerValue(headers: Record<string, string>, name: string): string | undefined {
	return headers[name.toLowerCase()];
}

function parseRtspUrl(input: string) {
	const parsed = new URL(input);
	parsed.username = '';
	parsed.password = '';
	const withoutCredentials = parsed.toString();
	const source = new URL(input);
	return {
		host: source.hostname,
		port: Number(source.port || 554),
		username: source.username,
		password: source.password,
		pathAndQuery: `${source.pathname}${source.search}`,
		uri: withoutCredentials
	};
}

export function parseScaleHeader(value: string | undefined): number | null {
	if (!value) return null;
	const rate = Number(value.trim());
	return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Highest supported rate that the DVR's answer actually covers. */
export function resolveAcceptedRate(requested: ClipRate, accepted: number | null): ClipRate | null {
	if (accepted === null) return requested;
	const usable = CLIP_RATES.filter((rate) => rate <= accepted + 0.01);
	const best = usable[usable.length - 1];
	if (!best || best === 1) return null;
	return Math.min(best, requested) as ClipRate;
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

/**
 * Size of the next complete RTSP message, or null when more bytes are needed.
 * Interleaved RTP frames start with `$` and carry a 16-bit length.
 */
export function measureRtspMessage(buffer: Buffer): { kind: 'interleaved' | 'text'; length: number } | null {
	if (buffer.length === 0) return null;
	if (buffer[0] === 0x24) {
		if (buffer.length < 4) return null;
		const length = buffer.readUInt16BE(2) + 4;
		return buffer.length < length ? null : { kind: 'interleaved', length };
	}

	const headerEnd = buffer.indexOf('\r\n\r\n');
	if (headerEnd < 0) return null;
	const head = buffer.subarray(0, headerEnd + 4).toString('utf8');
	const contentLength = Number(/^content-length:\s*(\d+)/im.exec(head)?.[1] ?? 0) || 0;
	const length = headerEnd + 4 + contentLength;
	return buffer.length < length ? null : { kind: 'text', length };
}

/**
 * Drops bytes that can never start a message, keeping a short tail in case a
 * status line was split across chunks. Without it the reader can stall on junk.
 */
export function resyncRtspBuffer(buffer: Buffer): Buffer {
	if (buffer.length === 0 || buffer[0] === 0x24) return buffer;
	if (buffer.subarray(0, 5).toString('ascii') === 'RTSP/') return buffer;
	const next = buffer.indexOf('RTSP/');
	if (next >= 0) return buffer.subarray(next);
	return buffer.subarray(Math.max(0, buffer.length - 4));
}

/** Forces our own Scale on PLAY requests; other messages pass through untouched. */
export function injectScaleHeader(message: string, rate: ClipRate): string {
	if (!/^PLAY\s/i.test(message)) return message;
	const withoutScale = message.replace(/^Scale:[^\r\n]*\r\n/gim, '');
	return withoutScale.replace(/\r\n\r\n$/, `\r\nScale: ${rate}\r\n\r\n`);
}

export function parseSdpTracks(sdp: string, baseUri: string): RtspSdpTrack[] {
	const tracks: RtspSdpTrack[] = [];
	let current: { kind: string; payloadTypes: string[]; control: string | null } | null = null;

	function pushCurrent() {
		if (!current) return;
		tracks.push({
			kind: current.kind,
			payloadTypes: current.payloadTypes,
			control: current.control,
			controlUrl: resolveRtspControlUrl(baseUri, current.control)
		});
	}

	for (const rawLine of sdp.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith('m=')) {
			pushCurrent();
			const parts = line.slice(2).split(/\s+/);
			current = { kind: parts[0] ?? 'video', payloadTypes: parts.slice(3), control: null };
			continue;
		}
		if (current && line.startsWith('a=control:')) current.control = line.slice('a=control:'.length);
	}
	pushCurrent();

	return tracks.filter((track) => track.payloadTypes.length > 0);
}

export function resolveRtspControlUrl(baseUri: string, control: string | null): string {
	if (!control || control === '*') return baseUri;
	if (/^rtsp:\/\//i.test(control)) return control;
	return `${baseUri.replace(/\/$/, '')}/${control.replace(/^\//, '')}`;
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

/** Minimal RTSP client used only to check whether the DVR accepts a Scale rate. */
class RtspProbeClient {
	private buffer: Buffer = Buffer.alloc(0);
	private cseq = 1;
	private wake: (() => void) | null = null;
	private fail: ((error: Error) => void) | null = null;
	private closed = false;
	private disposed = false;
	sessionId: string | null = null;

	constructor(
		private readonly socket: Socket,
		private readonly auth: { username: string; password: string }
	) {
		socket.on('data', (chunk) => {
			this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
			this.wake?.();
		});
		socket.on('error', (error) => this.fail?.(error));
		socket.on('close', () => {
			this.closed = true;
			this.wake?.();
		});
	}

	close() {
		if (this.disposed) return;
		this.disposed = true;
		this.socket.destroy();
	}

	/** Espera bytes novos: acordar com o buffer atual giraria em falso ate estourar a CPU. */
	private waitForData(seenLength: number): Promise<void> {
		if (this.buffer.length > seenLength || this.closed) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.wake = null;
				this.fail = null;
				reject(new Error('Tempo esgotado aguardando resposta RTSP do DVR.'));
			}, RESPONSE_TIMEOUT_MS);
			this.wake = () => {
				clearTimeout(timeout);
				this.wake = null;
				this.fail = null;
				resolve();
			};
			this.fail = (error) => {
				clearTimeout(timeout);
				this.wake = null;
				this.fail = null;
				reject(error);
			};
		});
	}

	private async readResponse(): Promise<RtspResponse> {
		const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
		while (true) {
			this.buffer = resyncRtspBuffer(this.buffer);
			const message = measureRtspMessage(this.buffer);
			if (message) {
				const raw = this.buffer.subarray(0, message.length);
				this.buffer = this.buffer.subarray(message.length);
				if (message.kind === 'interleaved') continue;
				return parseRtspResponse(raw.toString('utf8'));
			}
			if (this.closed) throw new Error('Conexao RTSP encerrada pelo DVR.');
			if (Date.now() >= deadline) throw new Error('Tempo esgotado aguardando resposta RTSP do DVR.');
			await this.waitForData(this.buffer.length);
		}
	}

	private async send(method: string, requestUri: string, headers: Record<string, string>): Promise<RtspResponse> {
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

	async request(method: string, requestUri: string, headers: Record<string, string> = {}): Promise<RtspResponse> {
		const response = await this.send(method, requestUri, headers);
		if (response.statusCode !== 401) return response;

		const challengeHeader = headerValue(response.headers, 'www-authenticate');
		if (!challengeHeader) return response;

		const authorization = /^Basic/i.test(challengeHeader)
			? `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password}`).toString('base64')}`
			: (() => {
					const challenge = parseDigestChallenge(challengeHeader);
					if (!challenge) return null;
					return buildDigestAuthorization({
						username: this.auth.username,
						password: this.auth.password,
						method,
						uri: requestUri,
						challenge
					});
				})();
		if (!authorization) return response;
		return await this.send(method, requestUri, { ...headers, Authorization: authorization });
	}
}

function parseSessionId(value: string | undefined): string | null {
	if (!value) return null;
	return value.split(';')[0]?.trim() || null;
}

/**
 * Runs a short RTSP handshake asking for `rate`, then tears the session down.
 * Returns the rate the DVR is willing to serve, or null to stay at 1x.
 */
export async function probeScaleSupport(opts: ProbeOptions): Promise<ClipRate | null> {
	if (opts.rate === 1) return null;
	const target = parseRtspUrl(opts.url);
	let client: RtspProbeClient | null = null;

	try {
		const socket = await connectRtsp(target.host, target.port);
		client = new RtspProbeClient(socket, { username: opts.username, password: opts.password });

		const describe = await client.request('DESCRIBE', target.uri, { Accept: 'application/sdp' });
		if (describe.statusCode !== 200 || !describe.body.trim()) return null;

		const contentBase = headerValue(describe.headers, 'content-base') ?? headerValue(describe.headers, 'content-location') ?? target.uri;
		const track = parseSdpTracks(describe.body, contentBase)[0];
		if (!track) return null;

		const setup = await client.request('SETUP', track.controlUrl, {
			Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1'
		});
		if (setup.statusCode !== 200) return null;
		const sessionId = parseSessionId(headerValue(setup.headers, 'session'));
		if (!sessionId) return null;

		const play = await client.request('PLAY', target.uri, {
			Session: sessionId,
			Range: 'npt=0-',
			Scale: String(opts.rate)
		});
		await client.request('TEARDOWN', target.uri, { Session: sessionId }).catch(() => undefined);
		// O DVR recusa a proxima sessao se ela chegar antes de ele liberar esta.
		await new Promise((resolve) => setTimeout(resolve, 250));
		if (play.statusCode !== 200) return null;

		return resolveAcceptedRate(opts.rate, parseScaleHeader(headerValue(play.headers, 'scale')));
	} catch (error) {
		console.warn(`[video] Nao foi possivel negociar Scale em ${opts.redactedUrl}: ${error instanceof Error ? error.message : error}`);
		return null;
	} finally {
		client?.close();
	}
}

/**
 * Local RTSP relay that forwards ffmpeg's session to the DVR byte for byte,
 * adding `Scale` to PLAY so the recording is delivered faster than realtime.
 * ffmpeg owns the handshake, so auth, transport and RTP framing stay untouched.
 */
export async function startScaledRtspProxy(opts: { url: string; rate: ClipRate }): Promise<ScaledRtspProxy> {
	const target = parseRtspUrl(opts.url);
	const sockets = new Set<Socket>();

	const server: Server = createServer((client) => {
		sockets.add(client);
		let pending = Buffer.alloc(0);
		let upstream: Socket | null = null;
		const queue: Buffer[] = [];

		const destroyBoth = () => {
			client.destroy();
			upstream?.destroy();
		};

		const forward = (chunk: Buffer) => {
			pending = Buffer.concat([pending, chunk]);
			const out: Buffer[] = [];
			while (pending.length > 0) {
				const message = measureRtspMessage(pending);
				if (!message) break;
				const raw = pending.subarray(0, message.length);
				pending = pending.subarray(message.length);
				out.push(message.kind === 'text' ? Buffer.from(injectScaleHeader(raw.toString('utf8'), opts.rate), 'utf8') : raw);
			}
			if (out.length === 0) return;
			const payload = Buffer.concat(out);
			if (upstream) upstream.write(payload);
			else queue.push(payload);
		};

		client.on('data', forward);
		client.on('error', destroyBoth);
		client.on('close', destroyBoth);

		void connectRtsp(target.host, target.port)
			.then((socket) => {
				upstream = socket;
				sockets.add(socket);
				socket.on('data', (chunk) => client.write(chunk));
				socket.on('error', destroyBoth);
				socket.on('close', destroyBoth);
				for (const chunk of queue.splice(0)) socket.write(chunk);
			})
			.catch(destroyBoth);
	});

	const port = await new Promise<number>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (typeof address === 'object' && address) resolve(address.port);
			else reject(new Error('Nao foi possivel abrir a porta local do proxy RTSP.'));
		});
	});

	const credentials = target.username ? `${target.username}:${target.password}@` : '';
	return {
		url: `rtsp://${credentials}127.0.0.1:${port}${target.pathAndQuery}`,
		redactedUrl: `rtsp://${target.username ? `${target.username}:***@` : ''}127.0.0.1:${port}${target.pathAndQuery}`,
		rate: opts.rate,
		close: () => {
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			server.close();
		}
	};
}
