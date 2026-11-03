/**
 * Similaridade por trigramas idêntica à do pg_trgm (`similarity()` / operador `%`), calculada na
 * aplicação porque o Aurora DSQL não tem extensões nem índice GIN.
 *
 * Mesmo algoritmo do pg_trgm: palavras = sequências de letras/dígitos, em minúsculas, cada uma
 * com dois espaços antes e um depois ("  joao "); conjunto de trigramas distintos; similaridade =
 * comuns / (A + B - comuns), em float4; 0 quando um dos lados não tem trigrama.
 * O script db:migrate-to-dsql confere este cálculo contra o pg_trgm do Aurora com nomes reais.
 */

/** Limite padrão do operador % do pg_trgm (pg_trgm.similarity_threshold). */
export const TRIGRAM_THRESHOLD = 0.3;

const WORD = /[\p{L}\p{N}]+/gu;
const THRESHOLD_F4 = Math.fround(TRIGRAM_THRESHOLD);

export function trigrams(text: string): Set<string> {
	const set = new Set<string>();
	for (const word of text.toLowerCase().match(WORD) ?? []) {
		const chars = Array.from(`  ${word} `);
		for (let i = 0; i + 3 <= chars.length; i++) set.add(chars[i]! + chars[i + 1]! + chars[i + 2]!);
	}
	return set;
}

export function trigramSimilarity(a: string | Set<string>, b: string | Set<string>): number {
	const ta = typeof a === 'string' ? trigrams(a) : a;
	const tb = typeof b === 'string' ? trigrams(b) : b;
	if (ta.size === 0 || tb.size === 0) return 0;
	const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
	let common = 0;
	for (const t of small) if (large.has(t)) common++;
	return Math.fround(common / (ta.size + tb.size - common));
}

/** Equivalente a `a % b` do pg_trgm. */
export function isTrigramMatch(score: number): boolean {
	return score >= THRESHOLD_F4;
}
