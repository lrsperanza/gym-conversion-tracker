import { defineConfig } from 'drizzle-kit';
import { env } from './src/config/env';

export default defineConfig({
	schema: './src/db/schema.ts',
	out: './drizzle',
	dialect: 'postgresql',
	dbCredentials: {
		host: env.postgres.host,
		port: env.postgres.port,
		user: env.postgres.user,
		password: env.postgres.password,
		database: env.postgres.database,
		ssl: env.postgres.ssl ? { rejectUnauthorized: false } : false
	},
	schemaFilter: ['gym-conversion-tracker'],
	verbose: true,
	strict: true
});
