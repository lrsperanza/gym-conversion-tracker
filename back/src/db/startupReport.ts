import { existsSync, readFileSync } from 'node:fs';
import { env } from '../config/env';
import { sql } from './client';

const mask = (value: string) => (value.length > 8 ? `${value.slice(0, 8)}…` : value);

/** AWS_ACCESS_KEY_ID escrito no .env da pasta atual (o Bun não sobrescreve variável que já existe no shell). */
function dotEnvAccessKey(): string | undefined {
	if (!existsSync('.env')) return undefined;
	const line = readFileSync('.env', 'utf8')
		.split(/\r?\n/)
		.find((l) => /^\s*AWS_ACCESS_KEY_ID\s*=/.test(l));
	return line?.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') || undefined;
}

function credentialSource(): string {
	const key = Bun.env.AWS_ACCESS_KEY_ID;
	if (key) return `AWS_ACCESS_KEY_ID ${mask(key)}`;
	if (Bun.env.AWS_PROFILE) return `AWS_PROFILE ${Bun.env.AWS_PROFILE}`;
	return 'cadeia padrão do SDK (~/.aws, perfil default)';
}

/** Mostra no boot a qual banco o back está ligado e testa o login (não derruba o servidor se falhar). */
export async function logDatabaseTarget() {
	const { endpoint, region, user } = env.dsql;
	console.info(`DB: Aurora DSQL ${endpoint} (região ${region}, usuário ${user}, schema "gym-conversion-tracker")`);
	console.info(`DB: credenciais AWS via ${credentialSource()}`);

	const fileKey = dotEnvAccessKey();
	const activeKey = Bun.env.AWS_ACCESS_KEY_ID;
	if (fileKey && activeKey && fileKey !== activeKey) {
		console.warn(
			`DB: ATENÇÃO — o AWS_ACCESS_KEY_ID do shell (${mask(activeKey)}) está sobrepondo o do .env (${mask(fileKey)}). ` +
				'No PowerShell: Remove-Item Env:AWS_ACCESS_KEY_ID, Env:AWS_SECRET_ACCESS_KEY'
		);
	}

	const started = Date.now();
	try {
		const [row] = await sql<Array<{ user: string }>>`SELECT current_user AS "user"`;
		console.info(`DB: conectado como ${row?.user} (${Date.now() - started} ms)`);
	} catch (error) {
		const err = error as { message?: string; hint?: string };
		console.error(`DB: FALHA ao conectar — ${err.message ?? String(error)}${err.hint ? ` — ${err.hint}` : ''}`);
	}
}
