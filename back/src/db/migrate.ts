import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DB_SCHEMA } from '../config/env';
import { closeDb, sql } from './client';

const migrationsDir = join(import.meta.dir, '..', '..', 'drizzle');

async function migrate() {
	await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${DB_SCHEMA}"`);
	await sql.unsafe(`
		CREATE TABLE IF NOT EXISTS "${DB_SCHEMA}"."_migrations" (
			"id" text PRIMARY KEY,
			"applied_at" timestamptz NOT NULL DEFAULT now()
		)
	`);

	const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();

	for (const file of files) {
		const alreadyApplied = await sql`
			SELECT 1 FROM "gym-conversion-tracker"."_migrations" WHERE "id" = ${file}
		`;

		if (alreadyApplied.length > 0) continue;

		const migration = await Bun.file(join(migrationsDir, file)).text();
		await sql.begin(async (tx) => {
			await tx.unsafe(migration);
			await tx`
				INSERT INTO "gym-conversion-tracker"."_migrations" ("id")
				VALUES (${file})
			`;
		});

		console.info(`Applied migration ${file}`);
	}
}

migrate()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(closeDb);

