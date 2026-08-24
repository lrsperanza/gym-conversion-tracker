import { createHash, randomBytes } from 'node:crypto';
import { VideoExtractorError } from './errors';

export type DvrCredentials = {
	host: string;
	rtspPort: number;
	httpPort: number;
	username: string;
	password: string;
};

export type PlaybackUrl = {
	url: string;
	redacted: string;
};

export function assertIntelbrasChannel(channel: number): number {
	if (!Number.isInteger(channel) || channel < 1) {
		throw new VideoExtractorError('INVALID_CAMERA', `Canal Intelbras inválido "${channel}". Use um inteiro a partir de 1.`);
	}
	return channel;
}

export function buildPlaybackUrl(opts: DvrCredentials & { channel: number; startDvr: string; endDvr: string }): PlaybackUrl {
	const channel = assertIntelbrasChannel(opts.channel);
	const username = encodeURIComponent(opts.username);
	const password = encodeURIComponent(opts.password);
	const query = `channel=${channel}&starttime=${opts.startDvr}&endtime=${opts.endDvr}`;
	const base = `${opts.host}:${opts.rtspPort}/cam/playback?${query}`;

	return {
		url: `rtsp://${username}:${password}@${base}`,
		redacted: `rtsp://${username}:***@${base}`
	};
}

export type PreflightResult = 'ok' | 'auth_failed' | 'unsupported' | 'unreachable';

function md5(input: string): string {
	return createHash('md5').update(input, 'utf8').digest('hex');
}

function quoteDigestValue(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function parseDigestChallenge(header: string | null): Record<string, string> | null {
	if (!header || !/^Digest\s/i.test(header.trim())) return null;
	const params: Record<string, string> = {};
	for (const match of header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) {
		params[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? '';
	}
	return params;
}

export function buildDigestAuthorization(opts: {
	username: string;
	password: string;
	method: string;
	uri: string;
	challenge: Record<string, string>;
}): string | null {
	const realm = opts.challenge.realm;
	const nonce = opts.challenge.nonce;
	if (!realm || !nonce) return null;

	const qopOptions = (opts.challenge.qop ?? '')
		.split(',')
		.map((option) => option.trim().toLowerCase());
	const qop = qopOptions.includes('auth') ? 'auth' : undefined;
	const ha1 = md5(`${opts.username}:${realm}:${opts.password}`);
	const ha2 = md5(`${opts.method}:${opts.uri}`);

	let response: string;
	let suffix = '';
	if (qop) {
		const nc = '00000001';
		const cnonce = randomBytes(8).toString('hex');
		response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
		suffix = `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
	} else {
		response = md5(`${ha1}:${nonce}:${ha2}`);
	}

	return (
		`Digest username="${quoteDigestValue(opts.username)}", ` +
		`realm="${quoteDigestValue(realm)}", nonce="${quoteDigestValue(nonce)}", ` +
		`uri="${quoteDigestValue(opts.uri)}", response="${response}"${suffix}`
	);
}

export async function checkHttpCredentials(credentials: DvrCredentials): Promise<PreflightResult> {
	const uri = '/cgi-bin/magicBox.cgi?action=getDeviceType';
	const base = `http://${credentials.host}:${credentials.httpPort}`;

	let challengeHeader: string | null;
	try {
		const first = await fetch(base + uri, { signal: AbortSignal.timeout(5000) });
		if (first.status === 200) return 'ok';
		if (first.status !== 401) return 'unsupported';
		challengeHeader = first.headers.get('www-authenticate');
	} catch {
		return 'unreachable';
	}

	const challenge = parseDigestChallenge(challengeHeader);
	if (!challenge) return 'unsupported';

	const authorization = buildDigestAuthorization({
		username: credentials.username,
		password: credentials.password,
		method: 'GET',
		uri,
		challenge
	});
	if (!authorization) return 'unsupported';

	try {
		const second = await fetch(base + uri, {
			headers: { Authorization: authorization },
			signal: AbortSignal.timeout(5000)
		});
		if (second.status === 200) return 'ok';
		if (second.status === 401) return 'auth_failed';
		return 'unsupported';
	} catch {
		return 'unreachable';
	}
}
