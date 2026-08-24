import { describe, expect, test } from 'bun:test';
import { parseRtspResponse, parseScaleHeader, parseSdpTracks, resolveRtspControlUrl, rewriteSdpForLocalRtp } from './rtspScale';

const SDP = [
	'v=0',
	'o=- 225971644 225971644 IN IP4 192.168.1.10',
	's=Media Server',
	'c=IN IP4 192.168.1.10',
	't=0 0',
	'a=control:*',
	'm=video 0 RTP/AVP 96',
	'a=rtpmap:96 H264/90000',
	'a=fmtp:96 packetization-mode=1;profile-level-id=42001f',
	'a=control:trackID=0',
	'm=audio 0 RTP/AVP 8',
	'a=rtpmap:8 PCMA/8000',
	'a=control:trackID=1',
	''
].join('\r\n');

describe('video RTSP Scale helpers', () => {
	test('parses RTSP responses with lower-case headers', () => {
		const response = parseRtspResponse('RTSP/1.0 200 OK\r\nCSeq: 4\r\nScale: 8.000\r\nSession: abc;timeout=60\r\n\r\n');
		expect(response.statusCode).toBe(200);
		expect(response.statusText).toBe('OK');
		expect(response.headers.scale).toBe('8.000');
		expect(response.headers.session).toBe('abc;timeout=60');
	});

	test('parses accepted scale values', () => {
		expect(parseScaleHeader('8.000')).toBe(8);
		expect(parseScaleHeader('')).toBeNull();
		expect(parseScaleHeader('invalid')).toBeNull();
	});

	test('resolves relative RTSP control URLs', () => {
		expect(resolveRtspControlUrl('rtsp://dvr/cam/playback?channel=1', 'trackID=0')).toBe(
			'rtsp://dvr/cam/playback?channel=1/trackID=0'
		);
		expect(resolveRtspControlUrl('rtsp://dvr/base/', '/trackID=0')).toBe('rtsp://dvr/base/trackID=0');
		expect(resolveRtspControlUrl('rtsp://dvr/base', 'rtsp://other/track')).toBe('rtsp://other/track');
	});

	test('parses SDP tracks and rewrites local RTP ports', () => {
		const tracks = parseSdpTracks(SDP, 'rtsp://dvr/cam/playback?channel=1');
		expect(tracks).toHaveLength(2);
		expect(tracks[0]?.kind).toBe('video');
		expect(tracks[0]?.payloadTypes).toEqual(['96']);
		expect(tracks[1]?.kind).toBe('audio');

		const localSdp = rewriteSdpForLocalRtp(SDP, [
			{ ...tracks[0]!, rtpPort: 41000, rtcpPort: 41001 },
			{ ...tracks[1]!, rtpPort: 41002, rtcpPort: 41003 }
		]);
		expect(localSdp).toContain('c=IN IP4 127.0.0.1');
		expect(localSdp).toContain('m=video 41000 RTP/AVP 96');
		expect(localSdp).toContain('a=rtcp:41001');
		expect(localSdp).toContain('a=rtpmap:96 H264/90000');
		expect(localSdp).toContain('m=audio 41002 RTP/AVP 8');
		expect(localSdp).not.toContain('a=control:');
	});
});
