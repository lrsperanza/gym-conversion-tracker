import { describe, expect, test } from 'bun:test';
import { assertIntelbrasChannel, buildDigestAuthorization, buildPlaybackUrl, parseDigestChallenge } from './intelbras';
import { VideoExtractorError } from './errors';

describe('video intelbras helpers', () => {
	test('validates one-based Intelbras channels', () => {
		expect(assertIntelbrasChannel(1)).toBe(1);
		expect(assertIntelbrasChannel(8)).toBe(8);
		expect(() => assertIntelbrasChannel(0)).toThrow(VideoExtractorError);
		expect(() => assertIntelbrasChannel(1.5)).toThrow(VideoExtractorError);
	});

	test('builds playback URL and redacts password', () => {
		const { url, redacted } = buildPlaybackUrl({
			host: '192.168.1.191',
			rtspPort: 554,
			httpPort: 80,
			channel: 1,
			username: 'adm in',
			password: 'p@ss/word:1',
			startDvr: '2026_08_24_09_30_00',
			endDvr: '2026_08_24_09_35_00'
		});
		expect(url).toContain('adm%20in:p%40ss%2Fword%3A1@');
		expect(url).toContain('channel=1');
		expect(url).toContain('starttime=2026_08_24_09_30_00');
		expect(redacted).not.toContain('p%40ss');
		expect(redacted).toContain('adm%20in:***@192.168.1.191:554');
	});

	test('builds Digest authorization header without leaking password', () => {
		const challenge = parseDigestChallenge('Digest realm="DVR", nonce="abc123", qop="auth"')!;
		const header = buildDigestAuthorization({
			username: 'admin',
			password: 's3cret',
			method: 'GET',
			uri: '/cgi-bin/magicBox.cgi?action=getDeviceType',
			challenge
		});
		expect(header).not.toBeNull();
		expect(header).toMatch(/^Digest /);
		expect(header).toContain('username="admin"');
		expect(header).toMatch(/response="[0-9a-f]{32}"/);
		expect(header).not.toContain('s3cret');
	});
});
