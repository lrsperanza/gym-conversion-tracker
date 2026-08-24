import { describe, expect, test } from 'bun:test';
import { formatDvrTimestamp, formatFilenameTimestamp, parseTimestamp, validateRange, zonedTimeToUtc } from './datetime';
import { VideoExtractorError } from './errors';

const TZ = 'America/Sao_Paulo';

describe('video datetime helpers', () => {
	test('honors ISO-8601 offsets', () => {
		expect(parseTimestamp('2026-08-24T09:30:00-03:00', TZ).toISOString()).toBe('2026-08-24T12:30:00.000Z');
		expect(parseTimestamp('2026-08-24T12:30:00Z', TZ).toISOString()).toBe('2026-08-24T12:30:00.000Z');
		expect(parseTimestamp('2026-08-24T09:30:00-0300', TZ).toISOString()).toBe('2026-08-24T12:30:00.000Z');
	});

	test('interprets offset-less timestamps in the gym timezone', () => {
		expect(parseTimestamp('2026-08-24 09:30:00', TZ).toISOString()).toBe('2026-08-24T12:30:00.000Z');
		expect(parseTimestamp('2026-08-24T09:30:00', TZ).toISOString()).toBe('2026-08-24T12:30:00.000Z');
	});

	test('rejects invalid timestamps and ranges', () => {
		expect(() => parseTimestamp('not a date', TZ)).toThrow(VideoExtractorError);
		expect(() => parseTimestamp('2026-02-30 10:00:00', TZ)).toThrow(VideoExtractorError);
		const start = parseTimestamp('2026-08-24T09:30:00-03:00', TZ);
		expect(() => validateRange(start, new Date(start))).toThrow(VideoExtractorError);
		expect(() => validateRange(start, parseTimestamp('2026-08-24T09:00:00-03:00', TZ))).toThrow(VideoExtractorError);
	});

	test('formats DVR and filesystem timestamps', () => {
		const date = parseTimestamp('2026-08-24T09:30:00-03:00', TZ);
		expect(formatDvrTimestamp(date, TZ)).toBe('2026_08_24_09_30_00');
		expect(formatFilenameTimestamp(date, TZ)).toBe('2026-08-24_09-30-00');
	});

	test('converts local wall-clock time to UTC', () => {
		expect(zonedTimeToUtc(2026, 1, 15, 12, 0, 0, TZ).toISOString()).toBe('2026-01-15T15:00:00.000Z');
	});
});
