import { Hono } from 'hono';
import { sql } from '../db/client';
import { assertCanAccessAcademy, hasAnyRole, requireAnyRole, requireAuth } from '../http/auth';
import { dashboardQuerySchema } from '../http/schemas';
import type { AppBindings } from '../http/types';

export const dashboardRoutes = new Hono<AppBindings>();

dashboardRoutes.use('*', requireAuth);
dashboardRoutes.use('*', requireAnyRole('ADMIN', 'SOCIO', 'GERENTE_REGIONAL'));

dashboardRoutes.get('/dashboard/summary', async (c) => {
	const user = c.get('user');
	const filters = parseDashboardQuery(c);
	if (filters.academyId) assertCanAccessAcademy(user, filters.academyId);

	const from = filters.from ? new Date(filters.from).toISOString() : null;
	const to = filters.to ? new Date(filters.to).toISOString() : null;
	const isGlobal = hasAnyRole(user, ['ADMIN', 'SOCIO']);
	const isManager = hasAnyRole(user, ['GERENTE_REGIONAL', 'LIDER']);
	const restrictToReceptionist = !isGlobal && !isManager;
	const access = { restrictToReceptionist, isGlobal, userId: user.id };
	// Atendimentos e conversão contam pela data do atendimento; receita e vendas
	// contam pela data efetiva da venda no EVO (mesmos filtros, menos o período).
	const scope = attendanceScopeSql(filters, from, to, access);
	const salesScope = attendanceScopeSql(filters, null, null, access);
	const periodCtes = sql`
		scoped AS (
			SELECT a.*
			FROM "gym-conversion-tracker"."attendances" a
			WHERE ${scope}
		), valid_sales AS (${dedupedSalesSql()}),
		period_sales AS (${periodSalesSql(salesScope, from, to)})
	`;

	const [kpi] = await sql<
		Array<{
			attendances: number;
			converted: number;
			sales: number;
			revenue_cents: number;
			evo_revenue_cents: number;
			recurring_bonus_cents: number;
		}>
	>`
		WITH ${periodCtes}
		SELECT
			(SELECT COUNT(*) FROM scoped)::int AS attendances,
			(SELECT COUNT(DISTINCT s."attendance_id") FROM scoped JOIN valid_sales s ON s."attendance_id" = scoped."id")::int AS converted,
			(SELECT COUNT(*) FROM period_sales)::int AS sales,
			(SELECT COALESCE(SUM("effective_cents"), 0) FROM period_sales)::int AS revenue_cents,
			(SELECT COALESCE(SUM("evo_cents"), 0) FROM period_sales)::int AS evo_revenue_cents,
			(SELECT COALESCE(SUM("recurring_bonus_cents"), 0) FROM period_sales)::int AS recurring_bonus_cents
	`;

	// Vendas lançadas que ainda não somam: aguardando a conferência noturna,
	// pendentes de pagamento ou dadas como não pagas.
	const payments = await sql<Array<{ payment_status: PaymentStatus; sales: number; amount_cents: number }>>`
		SELECT
			s."payment_status",
			COUNT(*)::int AS sales,
			COALESCE(SUM(s."effective_cents"), 0)::int AS amount_cents
		FROM (${periodSalesSql(salesScope, from, to, ['A_CONFERIR', 'PAGO', 'PAGAMENTO_PENDENTE', 'NAO_PAGO'])}) s
		GROUP BY s."payment_status"
	`;

	const receptionists = await sql`
		WITH ${periodCtes}, ${groupedMetricsSql('receptionist_id')}
		SELECT
			u."id",
			u."name",
			COALESCE(att."attendances", 0)::int AS attendances,
			COALESCE(att."converted", 0)::int AS converted,
			COALESCE(rev."revenue_cents", 0)::int AS revenue_cents,
			COALESCE(rev."recurring_bonus_cents", 0)::int AS recurring_bonus_cents
		FROM att
		FULL JOIN rev ON rev."key" = att."key"
		JOIN "gym-conversion-tracker"."users" u ON u."id" = COALESCE(att."key", rev."key")
		ORDER BY revenue_cents DESC, converted DESC
	`;

	const professors = await sql`
		WITH ${periodCtes}, ${groupedMetricsSql('professor_id')}
		SELECT
			p."id",
			p."name",
			COALESCE(att."attendances", 0)::int AS attendances,
			COALESCE(att."converted", 0)::int AS converted,
			COALESCE(rev."revenue_cents", 0)::int AS revenue_cents,
			COALESCE(rev."recurring_bonus_cents", 0)::int AS recurring_bonus_cents
		FROM att
		FULL JOIN rev ON rev."key" = att."key"
		JOIN "gym-conversion-tracker"."professors" p ON p."id" = COALESCE(att."key", rev."key")
		ORDER BY converted DESC, revenue_cents DESC
	`;

	const pairs = await sql`
		WITH ${periodCtes}, att AS (
			SELECT
				scoped."receptionist_id",
				scoped."professor_id",
				COUNT(DISTINCT scoped."id")::int AS attendances,
				COUNT(DISTINCT s."attendance_id")::int AS converted
			FROM scoped
			LEFT JOIN valid_sales s ON s."attendance_id" = scoped."id"
			WHERE scoped."professor_id" IS NOT NULL
			GROUP BY scoped."receptionist_id", scoped."professor_id"
		), rev AS (
			SELECT "receptionist_id", "professor_id", SUM("effective_cents")::int AS revenue_cents, SUM("recurring_bonus_cents")::int AS recurring_bonus_cents
			FROM period_sales
			WHERE "professor_id" IS NOT NULL
			GROUP BY "receptionist_id", "professor_id"
		), professor_global AS (
			SELECT "professor_id", SUM("attendances")::float AS total, SUM("converted")::float AS converted
			FROM att
			GROUP BY "professor_id"
		)
		SELECT
			u."name" AS receptionist_name,
			p."name" AS professor_name,
			COALESCE(att."attendances", 0)::int AS attendances,
			COALESCE(att."converted", 0)::int AS converted,
			COALESCE(rev."revenue_cents", 0)::int AS revenue_cents,
			COALESCE(rev."recurring_bonus_cents", 0)::int AS recurring_bonus_cents,
			CASE WHEN COALESCE(pg.total, 0) = 0 THEN 0 ELSE pg.converted / pg.total END AS professor_global_conversion_rate
		FROM att
		FULL JOIN rev ON rev."receptionist_id" = att."receptionist_id" AND rev."professor_id" = att."professor_id"
		JOIN "gym-conversion-tracker"."users" u ON u."id" = COALESCE(att."receptionist_id", rev."receptionist_id")
		JOIN "gym-conversion-tracker"."professors" p ON p."id" = COALESCE(att."professor_id", rev."professor_id")
		LEFT JOIN professor_global pg ON pg."professor_id" = p."id"
		ORDER BY revenue_cents DESC, converted DESC
	`;

	const closerScope = attendanceScopeSql(filters, null, null, { ...access, restrictToReceptionist: false });
	const closers = await sql`
		SELECT
			u."id",
			u."name",
			COUNT(s."id")::int AS sales,
			COALESCE(SUM(s."effective_cents"), 0)::int AS revenue_cents,
			COALESCE(SUM(s."recurring_bonus_cents"), 0)::int AS recurring_bonus_cents
		FROM (${periodSalesSql(closerScope, from, to)}) s
		JOIN "gym-conversion-tracker"."users" u ON u."id" = s."sold_by_user_id"
		WHERE (${restrictToReceptionist} = false OR s."sold_by_user_id" = ${user.id})
		GROUP BY u."id", u."name"
		ORDER BY revenue_cents DESC
	`;

	const timeline = await sql`
		WITH ${periodCtes}, att AS (
			SELECT
				(scoped."started_at" AT TIME ZONE 'America/Sao_Paulo')::date AS day,
				COUNT(DISTINCT scoped."id")::int AS attendances,
				COUNT(DISTINCT s."attendance_id")::int AS converted
			FROM scoped
			LEFT JOIN valid_sales s ON s."attendance_id" = scoped."id"
			GROUP BY 1
		), rev AS (
			SELECT ("sold_at" AT TIME ZONE 'America/Sao_Paulo')::date AS day, SUM("effective_cents")::int AS revenue_cents, SUM("recurring_bonus_cents")::int AS recurring_bonus_cents
			FROM period_sales
			GROUP BY 1
		)
		SELECT
			COALESCE(att.day, rev.day) AS day,
			COALESCE(att."attendances", 0)::int AS attendances,
			COALESCE(att."converted", 0)::int AS converted,
			COALESCE(rev."revenue_cents", 0)::int AS revenue_cents,
			COALESCE(rev."recurring_bonus_cents", 0)::int AS recurring_bonus_cents
		FROM att
		FULL JOIN rev ON rev.day = att.day
		ORDER BY 1
	`;

	return c.json({
		kpi: {
			...kpi,
			conversionRate: kpi?.attendances ? kpi.converted / kpi.attendances : 0
		},
		receptionists: withConversionRate([...receptionists] as Array<{ attendances: number; converted: number; revenue_cents: number }>),
		professors: withConversionRate([...professors] as Array<{ attendances: number; converted: number; revenue_cents: number }>),
		pairs: withConversionRate([...pairs] as Array<{ attendances: number; converted: number; revenue_cents: number }>),
		closers,
		payments: Object.fromEntries(
			(['A_CONFERIR', 'PAGO', 'PAGAMENTO_PENDENTE', 'NAO_PAGO'] as const).map((status) => {
				const row = payments.find((item) => item.payment_status === status);
				return [status, { sales: row?.sales ?? 0, amount_cents: row?.amount_cents ?? 0 }];
			})
		),
		timeline: withConversionRate([...timeline] as Array<{ attendances: number; converted: number; revenue_cents: number }>)
	});
});

// Opções do filtro de recepcionista: quem já registrou atendimento nas academias
// visíveis ao usuário (opcionalmente restrito a uma academia).
dashboardRoutes.get('/dashboard/receptionists', async (c) => {
	const user = c.get('user');
	const academyId = dashboardQuerySchema.shape.academyId.parse(c.req.query('academyId') || undefined);
	if (academyId) assertCanAccessAcademy(user, academyId);
	const isGlobal = hasAnyRole(user, ['ADMIN', 'SOCIO']);

	const receptionists = await sql<Array<{ id: string; name: string }>>`
		SELECT DISTINCT u."id", u."name"
		FROM "gym-conversion-tracker"."attendances" a
		JOIN "gym-conversion-tracker"."users" u ON u."id" = a."receptionist_id"
		WHERE (${academyId ?? null}::text IS NULL OR a."academy_id" = ${academyId ?? null})
			AND (
				${isGlobal} = true OR a."academy_id" IN (
					SELECT "academy_id" FROM "gym-conversion-tracker"."user_academy_roles"
					WHERE "user_id" = ${user.id} AND "active" = true AND "academy_id" IS NOT NULL
				)
			)
		ORDER BY u."name"
	`;

	return c.json({ receptionists });
});

dashboardRoutes.get('/dashboard/audit', async (c) => {
	const user = c.get('user');
	const filters = parseDashboardQuery(c);
	if (filters.academyId) assertCanAccessAcademy(user, filters.academyId);
	const from = filters.from ? new Date(filters.from).toISOString() : null;
	const to = filters.to ? new Date(filters.to).toISOString() : null;
	const isGlobal = hasAnyRole(user, ['ADMIN', 'SOCIO']);
	const isManager = hasAnyRole(user, ['GERENTE_REGIONAL', 'LIDER']);
	const restrictToReceptionist = !isGlobal && !isManager;

	const rows = await sql`
		SELECT *
		FROM (
			SELECT DISTINCT ON (a."id")
				a."id" AS attendance_id,
				a."academy_id",
				a."started_at",
				a."closed_at",
				a."status",
				l."name" AS lead_name,
				l."whatsapp_e164",
				u."name" AS receptionist_name,
				p."name" AS professor_name,
				s."label_snapshot",
				s."amount_cents",
				s."payment_status",
				s."payment_checked_at",
				s."payment_check_note",
				lr."label" AS loss_reason,
				lr."category" AS loss_category
			FROM "gym-conversion-tracker"."attendances" a
			JOIN "gym-conversion-tracker"."leads" l ON l."id" = a."lead_id"
			JOIN "gym-conversion-tracker"."users" u ON u."id" = a."receptionist_id"
			LEFT JOIN "gym-conversion-tracker"."professors" p ON p."id" = a."professor_id"
			LEFT JOIN "gym-conversion-tracker"."sales" s ON s."attendance_id" = a."id"
			LEFT JOIN "gym-conversion-tracker"."attendance_losses" al ON al."attendance_id" = a."id"
			LEFT JOIN "gym-conversion-tracker"."loss_reasons" lr ON lr."id" = al."loss_reason_id"
			WHERE ${attendanceScopeSql(filters, from, to, {
				restrictToReceptionist,
				isGlobal,
				userId: user.id
			})}
			ORDER BY a."id", a."started_at" DESC, s."created_at" DESC NULLS LAST
		) unique_attendances
		ORDER BY "started_at" DESC
		LIMIT 500
	`;

	return c.json({ rows });
});

function parseDashboardQuery(c: { req: { query: (key: string) => string | undefined } }) {
	return dashboardQuerySchema.parse({
		academyId: c.req.query('academyId') || undefined,
		receptionistId: c.req.query('receptionistId') || undefined,
		from: c.req.query('from') || undefined,
		to: c.req.query('to') || undefined,
		channel: c.req.query('channel') || undefined,
		weekdays: c.req.query('weekdays') || undefined,
		hourFrom: c.req.query('hourFrom') || undefined,
		hourTo: c.req.query('hourTo') || undefined
	});
}

type PaymentStatus = 'A_CONFERIR' | 'PAGO' | 'PAGAMENTO_PENDENTE' | 'NAO_PAGO';

type DashboardFilters = {
	academyId?: string;
	receptionistId?: string;
	channel?: 'PRESENCIAL' | 'ONLINE';
	weekdays?: string;
	hourFrom?: string;
	hourTo?: string;
};

function attendanceScopeSql(
	filters: DashboardFilters,
	from: string | null,
	to: string | null,
	access: { restrictToReceptionist: boolean; isGlobal: boolean; userId: string }
) {
	return sql`
		(${filters.academyId ?? null}::text IS NULL OR a."academy_id" = ${filters.academyId ?? null})
			AND (${from}::timestamptz IS NULL OR a."started_at" >= ${from}::timestamptz)
			AND (${to}::timestamptz IS NULL OR a."started_at" <= ${to}::timestamptz)
			AND (${filters.channel ?? null}::text IS NULL OR a."channel"::text = ${filters.channel ?? null})
			AND (${filters.receptionistId ?? null}::text IS NULL OR a."receptionist_id" = ${filters.receptionistId ?? null})
			${scheduleScopeSql(filters)}
			AND (${access.restrictToReceptionist} = false OR a."receptionist_id" = ${access.userId})
			AND (
				${access.isGlobal} = true OR a."academy_id" IN (
					SELECT "academy_id" FROM "gym-conversion-tracker"."user_academy_roles"
					WHERE "user_id" = ${access.userId} AND "active" = true AND "academy_id" IS NOT NULL
				)
			)
	`;
}

// Segmentação por grade horária: dia da semana (DOW, 0=domingo) e janela de horário,
// sempre no fuso de America/Sao_Paulo sobre a."started_at". hourTo é inclusivo até o fim do minuto.
function scheduleScopeSql(filters: Pick<DashboardFilters, 'weekdays' | 'hourFrom' | 'hourTo'>) {
	return sql`
		AND (${filters.weekdays ?? null}::text IS NULL OR EXTRACT(DOW FROM a."started_at" AT TIME ZONE 'America/Sao_Paulo')::int = ANY (string_to_array(${filters.weekdays ?? null}, ',')::int[]))
		AND (${filters.hourFrom ?? null}::time IS NULL OR (a."started_at" AT TIME ZONE 'America/Sao_Paulo')::time >= ${filters.hourFrom ?? null}::time)
		AND (${filters.hourTo ?? null}::time IS NULL OR (a."started_at" AT TIME ZONE 'America/Sao_Paulo')::time < (${filters.hourTo ?? null}::time + interval '1 minute'))
	`;
}

// Duas vendas para o mesmo lead no mesmo dia são impossíveis no domínio — o mínimo
// é uma perto da meia-noite e outra depois da 1h. Quando acontece (registro duplicado),
// vale só a ÚLTIMA venda do dia (created_at em America/Sao_Paulo), que é a válida.
//
// Só vendas com pagamento confirmado no EVO (`payment_status = 'PAGO'`) entram em
// receita e conversão. A conferência é feita pelo job `evo-payment-checker`.
function dedupedSalesSql(paymentStatuses: PaymentStatus[] = ['PAGO']) {
	// `evo_cents`/`sold_at`: valor pago e data da venda no EVO quando a venda já foi
	// confirmada; antes disso, valor e data do lançamento no tracker.
	// Plano recorrente é lançado no tracker com o valor dobrado, mas o EVO cobra só a
	// 1ª mensalidade: a outra fica em `recurring_bonus_cents` (bônus de venda de
	// recorrente, no máximo uma mensalidade e nunca acima do valor lançado).
	// `effective_cents` = venda EVO + bônus, que é a receita do dashboard.
	return sql`
		SELECT DISTINCT ON (la."lead_id", (s."created_at" AT TIME ZONE 'America/Sao_Paulo')::date)
			s.*,
			COALESCE(s."evo_paid_cents", s."amount_cents") AS evo_cents,
			b.recurring_bonus_cents,
			COALESCE(s."evo_paid_cents", s."amount_cents") + b.recurring_bonus_cents AS effective_cents,
			COALESCE(s."evo_sold_at", s."created_at") AS sold_at
		FROM "gym-conversion-tracker"."sales" s
		JOIN "gym-conversion-tracker"."attendances" la ON la."id" = s."attendance_id"
		CROSS JOIN LATERAL (
			SELECT CASE
				WHEN s."label_snapshot" ILIKE '%recorrente%' AND s."evo_paid_cents" IS NOT NULL
					THEN LEAST(s."evo_paid_cents", GREATEST(s."amount_cents" - s."evo_paid_cents", 0))
				ELSE 0
			END AS recurring_bonus_cents
		) b
		WHERE s."payment_status"::text = ANY (${paymentStatuses}::text[])
		ORDER BY la."lead_id", (s."created_at" AT TIME ZONE 'America/Sao_Paulo')::date, s."created_at" DESC
	`;
}

// Vendas cuja data efetiva cai no período, de atendimentos que passam pelos demais
// filtros (academia, canal, recepcionista, grade horária do atendimento, acesso).
function periodSalesSql(
	salesScope: ReturnType<typeof attendanceScopeSql>,
	from: string | null,
	to: string | null,
	paymentStatuses?: PaymentStatus[]
) {
	return sql`
		SELECT s.*, a."receptionist_id", a."professor_id"
		FROM (${dedupedSalesSql(paymentStatuses)}) s
		JOIN "gym-conversion-tracker"."attendances" a ON a."id" = s."attendance_id"
		WHERE ${salesScope}
			AND (${from}::timestamptz IS NULL OR s."sold_at" >= ${from}::timestamptz)
			AND (${to}::timestamptz IS NULL OR s."sold_at" <= ${to}::timestamptz)
	`;
}

// CTEs `att` (atendimentos/conversões do período) e `rev` (receita pela data da venda)
// agrupadas pela mesma coluna do atendimento; o chamador junta as duas com FULL JOIN.
function groupedMetricsSql(column: 'receptionist_id' | 'professor_id') {
	return sql`
		att AS (
			SELECT
				scoped.${sql(column)} AS key,
				COUNT(DISTINCT scoped."id")::int AS attendances,
				COUNT(DISTINCT s."attendance_id")::int AS converted
			FROM scoped
			LEFT JOIN valid_sales s ON s."attendance_id" = scoped."id"
			WHERE scoped.${sql(column)} IS NOT NULL
			GROUP BY 1
		), rev AS (
			SELECT ${sql(column)} AS key, SUM("effective_cents")::int AS revenue_cents, SUM("recurring_bonus_cents")::int AS recurring_bonus_cents
			FROM period_sales
			WHERE ${sql(column)} IS NOT NULL
			GROUP BY 1
		)
	`;
}

function withConversionRate<T extends { attendances: number; converted: number }>(rows: T[]) {
	return rows.map((row) => ({
		...row,
		conversionRate: row.attendances ? row.converted / row.attendances : 0
	}));
}
