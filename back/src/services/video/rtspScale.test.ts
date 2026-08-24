import { describe, expect, test } from 'bun:test';
import {
	injectScaleHeader,
	measureRtspMessage,
	parseRtspResponse,
	parseScaleHeader,
	parseSdpTracks,
	resolveAcceptedRate,
	resolveRtspControlUrl,
	resyncRtspBuffer
} from './rtspScale';

const SDP = [
	'v=0',
	'o=- 225971644 225971644 IN IP4 192.168.1.10',
	's=Media Server',
	'c=IN IP4 192.168.1.10',
	't=0 0',
	'a=control:*',
	'm=video 0 RTP/AVP 96',
	'a=rtpmap:96 H264/90000',
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

	test('falls back to the highest supported rate the DVR clamped to', () => {
		expect(resolveAcceptedRate(8, 8)).toBe(8);
		expect(resolveAcceptedRate(8, 4)).toBe(4);
		expect(resolveAcceptedRate(8, 3)).toBe(2);
		expect(resolveAcceptedRate(4, 8)).toBe(4);
		expect(resolveAcceptedRate(8, null)).toBe(8);
		expect(resolveAcceptedRate(8, 1)).toBeNull();
	});

	test('measures interleaved frames and text messages', () => {
		const interleaved = Buffer.concat([Buffer.from([0x24, 0x00, 0x00, 0x03]), Buffer.from([1, 2, 3])]);
		expect(measureRtspMessage(interleaved)).toEqual({ kind: 'interleaved', length: 7 });
		expect(measureRtspMessage(interleaved.subarray(0, 5))).toBeNull();

		const text = Buffer.from('PLAY rtsp://dvr/cam RTSP/1.0\r\nCSeq: 3\r\n\r\n');
		expect(measureRtspMessage(text)).toEqual({ kind: 'text', length: text.length });
		expect(measureRtspMessage(text.subarray(0, 12))).toBeNull();
	});

	test('resyncs the buffer to the next parseable message', () => {
		const junk = Buffer.concat([Buffer.from('garbage'), Buffer.from('RTSP/1.0 200 OK\r\n\r\n')]);
		expect(resyncRtspBuffer(junk).toString('utf8')).toBe('RTSP/1.0 200 OK\r\n\r\n');

		const clean = Buffer.from('RTSP/1.0 200 OK\r\n');
		expect(resyncRtspBuffer(clean)).toBe(clean);

		const interleaved = Buffer.from([0x24, 0x00, 0x00, 0x01, 0xff]);
		expect(resyncRtspBuffer(interleaved)).toBe(interleaved);

		// Junk with no status line keeps only a tail, so a split "RTSP/" still reassembles.
		expect(resyncRtspBuffer(Buffer.from('some long junk RT')).toString('utf8')).toBe('k RT');
	});

	test('injects Scale only into PLAY requests', () => {
		const play = 'PLAY rtsp://dvr/cam RTSP/1.0\r\nCSeq: 3\r\nRange: npt=0.000-\r\n\r\n';
		expect(injectScaleHeader(play, 8)).toBe(
			'PLAY rtsp://dvr/cam RTSP/1.0\r\nCSeq: 3\r\nRange: npt=0.000-\r\nScale: 8\r\n\r\n'
		);

		const describe = 'DESCRIBE rtsp://dvr/cam RTSP/1.0\r\nCSeq: 2\r\n\r\n';
		expect(injectScaleHeader(describe, 8)).toBe(describe);
	});

	test('replaces a Scale header the client already sent', () => {
		const play = 'PLAY rtsp://dvr/cam RTSP/1.0\r\nCSeq: 3\r\nScale: 1.000\r\n\r\n';
		const result = injectScaleHeader(play, 4);
		expect(result).toContain('Scale: 4');
		expect(result).not.toContain('Scale: 1.000');
	});

	test('parses SDP tracks and resolves control URLs', () => {
		const tracks = parseSdpTracks(SDP, 'rtsp://dvr/cam/playback?channel=1');
		expect(tracks).toHaveLength(2);
		expect(tracks[0]?.kind).toBe('video');
		expect(tracks[0]?.controlUrl).toBe('rtsp://dvr/cam/playback?channel=1/trackID=0');
		expect(tracks[1]?.kind).toBe('audio');
	});

	test('resolves relative and absolute RTSP control URLs', () => {
		expect(resolveRtspControlUrl('rtsp://dvr/base/', '/trackID=0')).toBe('rtsp://dvr/base/trackID=0');
		expect(resolveRtspControlUrl('rtsp://dvr/base', 'rtsp://other/track')).toBe('rtsp://other/track');
		expect(resolveRtspControlUrl('rtsp://dvr/base', '*')).toBe('rtsp://dvr/base');
	});
});
