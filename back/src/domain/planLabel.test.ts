import { describe, expect, it } from 'bun:test';
import { buildPlanLabel, formatBRL, isRecorrente } from './planLabel';

describe('plan labels', () => {
	it('formats cents as BRL', () => {
		expect(formatBRL(131880)).toBe('R$ 1.318,80');
	});

	it('appends the value to the label', () => {
		expect(buildPlanLabel('PLANO ANUAL', 131880)).toEqual({
			label: 'PLANO ANUAL · R$ 1.318,80',
			valueCents: 131880
		});
	});

	it('doubles recurring plan values before appending the suffix', () => {
		expect(buildPlanLabel('PLANO RECORRENTE', 10990)).toEqual({
			label: 'PLANO RECORRENTE · R$ 219,80',
			valueCents: 21980
		});
	});

	it('does not duplicate an existing value suffix', () => {
		expect(buildPlanLabel('PLANO ANUAL · R$ 1.318,80', 149880)).toEqual({
			label: 'PLANO ANUAL · R$ 1.498,80',
			valueCents: 149880
		});
	});

	it('detects recurring labels case-insensitively', () => {
		expect(isRecorrente('Plano recorrente 2025')).toBe(true);
	});
});
