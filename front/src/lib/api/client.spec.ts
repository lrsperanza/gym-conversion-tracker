import { describe, expect, it } from 'vitest';
import { money, percent } from './client';

describe('formatters', () => {
	it('formats money in BRL', () => {
		expect(money(12345)).toBe('R$ 123,45');
	});

	it('formats conversion rates as percentages', () => {
		expect(percent(0.257)).toBe('25,7%');
	});
});
