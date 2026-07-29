const OUTCOME_TYPE_KEY_ATTEMPTS = 5;

export function generateOutcomeTypeKey(randomUuid: () => string = () => crypto.randomUUID()): string {
	return `sale_${randomUuid().replaceAll('-', '').toLowerCase()}`;
}

export async function createWithUniqueOutcomeTypeKey<T>(
	insert: (key: string) => Promise<T | undefined>,
	generateKey: () => string = generateOutcomeTypeKey
): Promise<T> {
	for (let attempt = 0; attempt < OUTCOME_TYPE_KEY_ATTEMPTS; attempt += 1) {
		const created = await insert(generateKey());
		if (created !== undefined) return created;
	}

	throw new Error('Falha ao gerar uma chave única para o tipo de resultado.');
}
