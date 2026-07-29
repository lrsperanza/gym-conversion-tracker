import { describe, expect, it } from 'bun:test';
import { normalizeEmail, normalizeName, normalizePhone } from './normalize';

describe('normalization helpers', () => {
	it('normalizes names for duplicate checks', () => {
		expect(normalizeName('  João   da Silva ')).toBe('joao da silva');
	});

	it('normalizes emails', () => {
		expect(normalizeEmail(' ALUNO@EXEMPLO.COM ')).toBe('aluno@exemplo.com');
	});

	it('formats WhatsApp as E.164 with Brazil and DDD 16 defaults', () => {
		expect(normalizePhone({ number: '(99999) 1234' })).toEqual({
			countryCode: '55',
			areaCode: '16',
			number: '999991234',
			e164: '+5516999991234'
		});
	});
});
