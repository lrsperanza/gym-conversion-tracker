import { describe, expect, it } from 'vitest';
import { isQueueVisible, parsePhone } from './helpers';

describe('isQueueVisible', () => {
	const now = new Date('2026-07-29T21:00:00.000Z');

	it('hides finalized attendances', () => {
		expect(isQueueVisible({ status: 'FINALIZED', next_scheduled_for: null }, now)).toBe(false);
	});

	it('keeps regular in-progress attendances visible', () => {
		expect(isQueueVisible({ status: 'IN_PROGRESS', next_scheduled_for: null }, now)).toBe(true);
	});

	it('hides pending scheduled attendances until 15 minutes before the event', () => {
		expect(
			isQueueVisible({ status: 'PENDING', next_scheduled_for: '2026-07-29T21:20:00.000Z' }, now)
		).toBe(false);
	});

	it('shows pending scheduled attendances 15 minutes before the event', () => {
		expect(
			isQueueVisible({ status: 'PENDING', next_scheduled_for: '2026-07-29T21:15:00.000Z' }, now)
		).toBe(true);
	});
});

describe('parsePhone', () => {
	it('parses local Brazilian phone numbers', () => {
		expect(parsePhone('(16) 99999-8888')).toEqual({
			countryCode: '55',
			areaCode: '16',
			number: '999998888'
		});
	});

	it('removes an existing +55 prefix', () => {
		expect(parsePhone('+55 16 99999-8888')).toEqual({
			countryCode: '55',
			areaCode: '16',
			number: '999998888'
		});
	});

	it('rejects incomplete numbers', () => {
		expect(parsePhone('12345')).toBeNull();
	});
});
