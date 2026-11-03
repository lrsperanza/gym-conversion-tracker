import { describe, expect, it } from 'bun:test';
import { isTrigramMatch, trigramSimilarity, trigrams } from './trigram';

describe('trigrams (pg_trgm)', () => {
	it('pads each word like pg_trgm', () => {
		expect([...trigrams('Ab')].sort()).toEqual(['  a', ' ab', 'ab ']);
		expect(trigrams('').size).toBe(0);
		expect(trigrams('--- !!').size).toBe(0);
	});

	it('matches values computed by pg_trgm', () => {
		// SELECT similarity(a, b) no PostgreSQL com pg_trgm
		expect(trigramSimilarity('word', 'two words')).toBeCloseTo(0.363636, 5);
		expect(trigramSimilarity('joao da silva', 'joao silva')).toBeCloseTo(0.785714, 5);
		expect(trigramSimilarity('abc', 'abc')).toBe(1);
		expect(trigramSimilarity('', 'abc')).toBe(0);
	});

	it('uses the % threshold of 0.3', () => {
		expect(isTrigramMatch(trigramSimilarity('joao da silva', 'joao silva'))).toBe(true);
		expect(isTrigramMatch(trigramSimilarity('maria', 'pedro'))).toBe(false);
	});
});
