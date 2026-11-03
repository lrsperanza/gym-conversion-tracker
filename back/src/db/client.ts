import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { DsqlSigner } from '@aws-sdk/dsql-signer';
import { env } from '../config/env';
import * as schema from './schema';

function dsqlConnection() {
	const { endpoint, region, user } = env.dsql;
	if (!endpoint) {
		throw new Error('DSQL_ENDPOINT não configurado. O banco do back é o Aurora DSQL: defina DSQL_ENDPOINT e as credenciais AWS no .env.');
	}
	if (!region) throw new Error(`Não foi possível deduzir a região de DSQL_ENDPOINT (${endpoint}); defina DSQL_REGION.`);
	const signer = new DsqlSigner({ hostname: endpoint, region });
	return {
		host: endpoint,
		port: 5432,
		database: 'postgres',
		username: user,
		// Token IAM com validade de 15 min, gerado a cada conexão nova (só é checado no login).
		password: () => (user === 'admin' ? signer.getDbConnectAdminAuthToken() : signer.getDbConnectAuthToken()),
		ssl: true
	} as const;
}

export const sql = postgres({
	...dsqlConnection(),
	max: 10,
	prepare: false,
	connect_timeout: 30,
	// O DSQL encerra conexões com 1 h; recicla antes disso.
	max_lifetime: 45 * 60
});

export const db = drizzle(sql, { schema });

export async function closeDb() {
	await sql.end({ timeout: 5 });
}
