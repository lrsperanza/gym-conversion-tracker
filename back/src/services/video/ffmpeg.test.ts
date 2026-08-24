import { describe, expect, test } from 'bun:test';
import { classifyFfmpegError, redactSecrets } from './ffmpeg';

describe('video ffmpeg helpers', () => {
	test('redacts full URLs and password forms', () => {
		const url = 'rtsp://gymapi:p%40ss%2Fword@192.168.1.191:554/cam/playback?channel=1';
		const out = redactSecrets(`Input #0, rtsp, from '${url}' with p@ss/word`, [url, 'p@ss/word', 'p%40ss%2Fword']);
		expect(out).not.toContain('p@ss/word');
		expect(out).not.toContain('p%40ss%2Fword');
		expect(out).toContain('Input #0, rtsp');
	});

	test('classifies common ffmpeg failures', () => {
		expect(classifyFfmpegError('method DESCRIBE failed: 401 Unauthorized').code).toBe('AUTH_FAILED');
		expect(classifyFfmpegError('Connection refused by 192.168.1.191').code).toBe('DVR_UNREACHABLE');
		expect(classifyFfmpegError('Connection timed out after 15 seconds').code).toBe('RTSP_ERROR');
		expect(classifyFfmpegError('Conversion failed!').code).toBe('RTSP_ERROR');
	});
});
