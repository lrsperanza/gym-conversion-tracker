import { describe, expect, test } from 'bun:test';
import { parseRangeHeader } from './byteRange';

describe('parseRangeHeader', () => {
	test('returns null when the header is absent', () => {
		expect(parseRangeHeader(undefined, 100)).toBeNull();
	});

	test('parses closed, open and suffix ranges', () => {
		expect(parseRangeHeader('bytes=0-99', 200)).toEqual({ start: 0, end: 99 });
		expect(parseRangeHeader('bytes=50-', 200)).toEqual({ start: 50, end: 199 });
		expect(parseRangeHeader('bytes=-20', 200)).toEqual({ start: 180, end: 199 });
	});

	test('rejects empty, inverted and out-of-bounds ranges', () => {
		expect(parseRangeHeader('bytes=-', 200)).toBe('invalid');
		expect(parseRangeHeader('bytes=20-10', 200)).toBe('invalid');
		expect(parseRangeHeader('bytes=200-210', 200)).toBe('invalid');
		expect(parseRangeHeader('items=0-10', 200)).toBe('invalid');
		expect(parseRangeHeader('bytes=0-10', 0)).toBe('invalid');
	});
});
