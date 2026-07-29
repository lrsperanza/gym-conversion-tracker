import { describe, expect, it } from 'bun:test';
import { createWithUniqueOutcomeTypeKey, generateOutcomeTypeKey } from './outcomeTypeKey';

describe('outcome type keys', () => {
	it('generates a safe server-side key', () => {
		const key = generateOutcomeTypeKey(() => '550E8400-E29B-41D4-A716-446655440000');

		expect(key).toBe('sale_550e8400e29b41d4a716446655440000');
		expect(key).toMatch(/^[a-z0-9_]+$/);
	});

	it('retries key collisions', async () => {
		const attemptedKeys: string[] = [];
		const keys = ['sale_collision', 'sale_unique'];

		const created = await createWithUniqueOutcomeTypeKey(
			async (key) => {
				attemptedKeys.push(key);
				return key === 'sale_unique' ? { key } : undefined;
			},
			() => keys.shift()!
		);

		expect(created).toEqual({ key: 'sale_unique' });
		expect(attemptedKeys).toEqual(['sale_collision', 'sale_unique']);
	});

	it('fails after repeated key collisions', async () => {
		expect(createWithUniqueOutcomeTypeKey(async () => undefined, () => 'sale_collision')).rejects.toThrow(
			'Falha ao gerar uma chave única'
		);
	});
});
