import { sql } from '../db/client';
import { isTrigramMatch, trigramSimilarity, trigrams } from '../domain/trigram';

export type NameMatch = { id: string; score: number };

/**
 * Substitui `normalized_name % $1` / `similarity(normalized_name, $1)` do pg_trgm: lê id + nome
 * normalizado da tabela e calcula a similaridade na aplicação (veja domain/trigram.ts).
 * Devolve só quem passa do limite do %, da maior para a menor similaridade.
 */
export async function findSimilarNames(table: 'leads' | 'users', normalizedQuery: string, limit?: number): Promise<NameMatch[]> {
	const query = trigrams(normalizedQuery);
	if (query.size === 0) return [];
	const rows =
		table === 'leads'
			? await sql<Array<{ id: string; normalized_name: string }>>`SELECT "id", "normalized_name" FROM "gym-conversion-tracker"."leads"`
			: await sql<Array<{ id: string; normalized_name: string }>>`SELECT "id", "normalized_name" FROM "gym-conversion-tracker"."users"`;
	const matches: NameMatch[] = [];
	for (const row of rows) {
		const score = trigramSimilarity(row.normalized_name, query);
		if (isTrigramMatch(score)) matches.push({ id: row.id, score });
	}
	matches.sort((a, b) => b.score - a.score);
	return limit === undefined ? matches : matches.slice(0, limit);
}
