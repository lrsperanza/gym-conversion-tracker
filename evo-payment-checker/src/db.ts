import postgres from 'postgres';
import { DsqlSigner } from '@aws-sdk/dsql-signer';
import { decryptAesGcm } from './crypto.ts';
import { env } from './env.ts';
import type { PaymentStatus } from './matching.ts';

function dsqlConnection() {
	const { endpoint, region, user } = env.dsql;
	if (!endpoint) throw new Error('DSQL_ENDPOINT não configurado (mesmo valor do back/.env).');
	if (!region) throw new Error(`Não foi possível deduzir a região de DSQL_ENDPOINT (${endpoint}); defina DSQL_REGION.`);
	const signer = new DsqlSigner({ hostname: endpoint, region });
	return {
		host: endpoint,
		port: 5432,
		database: 'postgres',
		username: user,
		password: () => (user === 'admin' ? signer.getDbConnectAdminAuthToken() : signer.getDbConnectAuthToken()),
		ssl: true
	} as const;
}

export const sql = postgres({
	...dsqlConnection(),
	max: 2,
	connect_timeout: 30,
	prepare: false,
	max_lifetime: 45 * 60 // o DSQL encerra conexões com 1 h
});

/** Aurora DSQL: conflito de concorrência otimista (SQLSTATE 40001 / OC000 / OC001) — refazer resolve. */
async function withConflictRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn();
		} catch (error) {
			const err = error as { code?: unknown; message?: unknown };
			const conflict = err?.code === '40001' || /\(OC00\d\)/.test(String(err?.message ?? ''));
			if (!conflict || attempt >= attempts) throw error;
			await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 25 * 2 ** attempt) * (0.5 + Math.random())));
		}
	}
}

export type EvoCredentials = { usuario: string; senha: string; segredoTotp?: string };

export async function loadCredentials(email: string): Promise<EvoCredentials> {
	const [row] = await sql<
		Array<{ evo_username: string | null; evo_password_encrypted: string | null; evo_totp_secret_encrypted: string | null }>
	>`
		SELECT "evo_username", "evo_password_encrypted", "evo_totp_secret_encrypted"
		FROM "gym-conversion-tracker"."users"
		WHERE lower("email") = lower(${email}) AND "active" = true
	`;
	if (!row) throw new Error(`Usuário ${email} não encontrado (ou inativo) no tracker.`);
	if (!row.evo_username || !row.evo_password_encrypted) {
		throw new Error(`O usuário ${email} não tem credenciais EVO salvas em Conta.`);
	}
	return {
		usuario: row.evo_username,
		senha: decryptAesGcm(row.evo_password_encrypted, env.evoCredKey),
		segredoTotp: row.evo_totp_secret_encrypted
			? decryptAesGcm(row.evo_totp_secret_encrypted, env.evoCredKey)
			: undefined
	};
}

export type SaleToCheck = {
	id: string;
	created_at: Date;
	amount_cents: number;
	label_snapshot: string;
	payment_status: PaymentStatus;
	academy_id: string;
	academy_name: string;
	evo_unit_name: string | null;
	lead_name: string;
	lead_surname: string | null;
	lead_cpf: string | null;
	lead_email: string | null;
	lead_whatsapp: string | null;
	/** Usuário do tracker que registrou a venda — no EVO é o "Colaborador venda". */
	seller_name: string | null;
};

/**
 * Vendas novas (A_CONFERIR) de dias já encerrados no fuso da academia + todas
 * as pendentes. Venda lançada hoje espera a rodada da madrugada seguinte,
 * a menos que `includeToday` seja pedido (teste manual).
 */
export async function loadSalesToCheck(options: { includeToday: boolean; saleId?: string }): Promise<SaleToCheck[]> {
	const tz = env.timeZone;
	return sql<SaleToCheck[]>`
		SELECT
			s."id",
			s."created_at",
			s."amount_cents",
			s."label_snapshot",
			s."payment_status",
			a."academy_id",
			ac."name" AS academy_name,
			ac."evo_unit_name",
			l."name" AS lead_name,
			l."surname" AS lead_surname,
			l."cpf" AS lead_cpf,
			l."email" AS lead_email,
			l."whatsapp_e164" AS lead_whatsapp,
			u."name" AS seller_name
		FROM "gym-conversion-tracker"."sales" s
		LEFT JOIN "gym-conversion-tracker"."users" u ON u."id" = s."sold_by_user_id"
		JOIN "gym-conversion-tracker"."attendances" a ON a."id" = s."attendance_id"
		JOIN "gym-conversion-tracker"."academies" ac ON ac."id" = a."academy_id"
		JOIN "gym-conversion-tracker"."leads" l ON l."id" = a."lead_id"
		WHERE (${options.saleId ?? null}::uuid IS NULL OR s."id" = ${options.saleId ?? null}::uuid)
			AND (
				s."payment_status" = 'PAGAMENTO_PENDENTE'
				OR (
					s."payment_status" = 'A_CONFERIR'
					AND (
						${options.includeToday}
						OR s."created_at" < (date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})
					)
				)
			)
		ORDER BY ac."name", s."created_at"
	`;
}

/** Vendas do EVO já usadas para confirmar alguma venda do tracker. */
export async function loadUsedEvoSaleIds(): Promise<Set<number>> {
	const rows = await sql<Array<{ evo_sale_id: number }>>`
		SELECT "evo_sale_id" FROM "gym-conversion-tracker"."sales" WHERE "evo_sale_id" IS NOT NULL
	`;
	return new Set(rows.map((row) => row.evo_sale_id));
}

export type SaleUpdate = {
	status: PaymentStatus;
	note: string;
	evoClientId?: number | null;
	evoSaleId?: number | null;
	evoPaidCents?: number | null;
	evoSoldAt?: Date | null;
};

export async function saveSaleCheck(saleId: string, update: SaleUpdate): Promise<void> {
	await withConflictRetry(() => sql`
		UPDATE "gym-conversion-tracker"."sales"
		SET "payment_status" = ${update.status},
			"payment_checked_at" = now(),
			"payment_check_count" = "payment_check_count" + 1,
			"payment_check_note" = ${update.note},
			"payment_confirmed_at" = CASE WHEN ${update.status} = 'PAGO' THEN now() ELSE "payment_confirmed_at" END,
			"evo_client_id" = COALESCE(${update.evoClientId ?? null}::int, "evo_client_id"),
			"evo_sale_id" = ${update.evoSaleId ?? null}::int,
			"evo_paid_cents" = ${update.evoPaidCents ?? null}::int,
			"evo_sold_at" = ${update.evoSoldAt?.toISOString() ?? null}::timestamptz
		WHERE "id" = ${saleId}
	`);
}

export async function closeDb(): Promise<void> {
	await sql.end({ timeout: 5 });
}
