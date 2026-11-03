import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DB_SCHEMA } from '../config/env';
import { closeDb, sql } from './client';

/**
 * Runner de migrations para o Aurora DSQL.
 *
 * O DSQL não aceita DDL e DML na mesma transação nem mais de um DDL por transação, então cada
 * comando do arquivo roda sozinho (autocommit) e só no fim o arquivo é registrado em _migrations.
 * Consequências para quem escreve migration nova (veja AGENTS.md):
 *   - escreva comandos idempotentes (IF NOT EXISTS / IF EXISTS): se um comando falhar no meio,
 *     os anteriores já ficaram aplicados e o arquivo roda de novo do início na próxima vez;
 *   - nada de DO $$ (PL/pgSQL), CREATE TYPE/ENUM, extensões ou TRUNCATE;
 *   - índice em tabela com dados: CREATE INDEX ASYNC (o DSQL só cria índice síncrono em tabela vazia);
 *   - UPDATE/DELETE de backfill: no máximo 3.000 linhas por comando.
 * As migrations 0000–0011 foram escritas para o Aurora e já constam como aplicadas.
 */

const migrationsDir = join(import.meta.dir, '..', '..', 'drizzle');

/** Divide o arquivo em comandos no ';', respeitando strings, identificadores, $$ e comentários. */
export function splitStatements(source: string): string[] {
	const statements: string[] = [];
	let current = '';
	let i = 0;
	while (i < source.length) {
		const ch = source[i]!;
		const next = source[i + 1];
		if (ch === '-' && next === '-') {
			const end = source.indexOf('\n', i);
			i = end === -1 ? source.length : end + 1;
			current += '\n';
			continue;
		}
		if (ch === '/' && next === '*') {
			const end = source.indexOf('*/', i + 2);
			i = end === -1 ? source.length : end + 2;
			current += ' ';
			continue;
		}
		if (ch === "'" || ch === '"') {
			let j = i + 1;
			while (j < source.length) {
				if (source[j] === ch) {
					if (source[j + 1] === ch) {
						j += 2;
						continue;
					}
					break;
				}
				j++;
			}
			current += source.slice(i, j + 1);
			i = j + 1;
			continue;
		}
		if (ch === '$') {
			const tag = /^\$[A-Za-z_]*\$/.exec(source.slice(i))?.[0];
			if (tag) {
				const end = source.indexOf(tag, i + tag.length);
				const stop = end === -1 ? source.length : end + tag.length;
				current += source.slice(i, stop);
				i = stop;
				continue;
			}
		}
		if (ch === ';') {
			if (current.trim()) statements.push(current.trim());
			current = '';
			i++;
			continue;
		}
		current += ch;
		i++;
	}
	if (current.trim()) statements.push(current.trim());
	return statements;
}

async function migrate() {
	await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${DB_SCHEMA}"`);
	await sql.unsafe(`
		CREATE TABLE IF NOT EXISTS "${DB_SCHEMA}"."_migrations" (
			"id" text PRIMARY KEY,
			"applied_at" timestamptz NOT NULL DEFAULT now()
		)
	`);

	const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
	const applied = new Set(
		(await sql<Array<{ id: string }>>`SELECT "id" FROM "gym-conversion-tracker"."_migrations"`).map((row) => row.id)
	);

	for (const file of files) {
		if (applied.has(file)) continue;

		const statements = splitStatements(await Bun.file(join(migrationsDir, file)).text());
		for (const [index, statement] of statements.entries()) {
			try {
				await sql.unsafe(statement);
			} catch (error) {
				console.error(`Falha em ${file}, comando ${index + 1}/${statements.length}:\n${statement}\n`);
				throw error;
			}
		}
		await sql`
			INSERT INTO "gym-conversion-tracker"."_migrations" ("id")
			VALUES (${file})
		`;

		console.info(`Applied migration ${file} (${statements.length} comandos)`);
	}
}

if (import.meta.main) {
	migrate()
		.catch((error) => {
			console.error(error);
			process.exitCode = 1;
		})
		.finally(closeDb);
}
