import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { env } from '../config/env';
import * as schema from './schema';

export const sql = postgres({
	host: env.postgres.host,
	port: env.postgres.port,
	database: env.postgres.database,
	username: env.postgres.user,
	password: env.postgres.password,
	ssl: env.postgres.ssl ? { rejectUnauthorized: false } : false,
	max: 10,
	prepare: false
});

export const db = drizzle(sql, { schema });

export async function closeDb() {
	await sql.end({ timeout: 5 });
}

