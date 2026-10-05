import { describe, expect, test } from 'bun:test';
import { calculateAudioCoverage, computeAudioParts } from './clip';

const base = new Date('2026-09-30T12:00:00.000Z');

function minutes(value: number) {
	return new Date(base.getTime() + value * 60_000);
}

function ranges(windows: ReturnType<typeof computeAudioParts>) {
	return windows.map((window) => ({
		part: window.part,
		start: Math.round((window.windowStart.getTime() - base.getTime()) / 60_000),
		end: Math.round((window.windowEnd.getTime() - base.getTime()) / 60_000)
	}));
}

describe('audio clip windows', () => {
	test('does not ask for audio before an open attendance reaches the head window', () => {
		expect(computeAudioParts(base, null, minutes(9), 10)).toEqual([]);
	});

	test('asks for the first 10 minutes while a long attendance is still open', () => {
		expect(ranges(computeAudioParts(base, null, minutes(10), 10))).toEqual([{ part: 'HEAD', start: 0, end: 10 }]);
	});

	test('keeps the full attendance when it is shorter than 10 minutes', () => {
		expect(ranges(computeAudioParts(base, minutes(5), minutes(5), 10))).toEqual([{ part: 'FULL', start: 0, end: 5 }]);
	});

	test('keeps the full attendance when it is exactly 10 minutes', () => {
		expect(ranges(computeAudioParts(base, minutes(10), minutes(10), 10))).toEqual([{ part: 'FULL', start: 0, end: 10 }]);
	});

	test('does not overlap head and tail for a 14 minute attendance', () => {
		expect(ranges(computeAudioParts(base, minutes(14), minutes(14), 10))).toEqual([
			{ part: 'HEAD', start: 0, end: 10 },
			{ part: 'TAIL', start: 10, end: 14 }
		]);
	});

	test('keeps first and last 10 minutes for longer attendances', () => {
		expect(ranges(computeAudioParts(base, minutes(20), minutes(20), 10))).toEqual([
			{ part: 'HEAD', start: 0, end: 10 },
			{ part: 'TAIL', start: 10, end: 20 }
		]);
		expect(ranges(computeAudioParts(base, minutes(25), minutes(25), 10))).toEqual([
			{ part: 'HEAD', start: 0, end: 10 },
			{ part: 'TAIL', start: 15, end: 25 }
		]);
	});

	test('keeps a bounded tail even when the attendance is far beyond the local buffer', () => {
		expect(ranges(computeAudioParts(base, minutes(300), minutes(300), 10))).toEqual([
			{ part: 'HEAD', start: 0, end: 10 },
			{ part: 'TAIL', start: 290, end: 300 }
		]);
	});
});

describe('audio coverage', () => {
	test('reports gaps after merging overlapping chunks', () => {
		const coverage = calculateAudioCoverage(minutes(0), minutes(10), [
			{ path: 'a.webm', startedAt: minutes(-1), endedAt: minutes(4) },
			{ path: 'b.webm', startedAt: minutes(3.5), endedAt: minutes(7) },
			{ path: 'c.webm', startedAt: minutes(8), endedAt: minutes(12) }
		]);

		expect(coverage.coveredSeconds).toBe(540);
		expect(coverage.gaps).toEqual([{ start: minutes(7).toISOString(), end: minutes(8).toISOString(), seconds: 60 }]);
		expect(coverage.chunks.map((chunk) => Math.round(chunk.durationSeconds))).toEqual([240, 210, 120]);
	});
});
