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
	const scope = attendanceScopeSql(filters, from, to, {
		restrictToReceptionist,
		isGlobal,
		userId: user.id
	});

	const [kpi] = await sql<Array<{ attendances: number; converted: number; revenue_cents: number }>>`
		WITH scoped AS (
			SELECT a.*
			FROM "gym-conversion-tracker"."attendances" a
			WHERE ${scope}
		)
		SELECT
			COUNT(DISTINCT scoped."id")::int AS attendances,
			COUNT(DISTINCT s."attendance_id")::int AS converted,
			COALESCE(SUM(s."amount_cents"), 0)::int AS revenue_cents
		FROM scoped
		LEFT JOIN "gym-conversion-tracker"."sales" s ON s."attendance_id" = scoped."id"
	`;

	const receptionists = await sql`
		WITH scoped AS (
			SELECT a.*
			FROM "gym-conversion-tracker"."attendances" a
			WHERE ${scope}
		)
		SELECT
			u."id",
			u."name",
			COUNT(DISTINCT scoped."id")::int AS attendances,
			COUNT(DISTINCT s."attendance_id")::int AS converted,
			COALESCE(SUM(s."amount_cents"), 0)::int AS revenue_cents
		FROM scoped
		JOIN "gym-conversion-tracker"."users" u ON u."id" = scoped."receptionist_id"
		LEFT JOIN "gym-conversion-tracker"."sales" s ON s."attendance_id" = scoped."id"
		GROUP BY u."id", u."name"
		ORDER BY revenue_cents DESC, converted DESC
	`;

	const professors = await sql`
		WITH scoped AS (
			SELECT a.*
			FROM "gym-conversion-tracker"."attendances" a
			WHERE a."professor_id" IS NOT NULL
				AND ${scope}
		)
		SELECT
			p."id",
			p."name",
			COUNT(DISTINCT scoped."id")::int AS attendances,
			COUNT(DISTINCT s."attendance_id")::int AS converted,
			COALESCE(SUM(s."amount_cents"), 0)::int AS revenue_cents
		FROM scoped
		JOIN "gym-conversion-tracker"."professors" p ON p."id" = scoped."professor_id"
		LEFT JOIN "gym-conversion-tracker"."sales" s ON s."attendance_id" = scoped."id"
		GROUP BY p."id", p."name"
		ORDER BY converted DESC, revenue_cents DESC
	`;

	const pairs = await sql`
		WITH scoped AS (
			SELECT a.*
			FROM "gym-conversion-tracker"."attendances" a
			WHERE a."professor_id" IS NOT NULL
				AND ${scope}
	), professor_global AS (
		SELECT scoped."professor_id", COUNT(DISTINCT scoped."id")::float AS total, COUNT(DISTINCT s."attendance_id")::float AS converted
		FROM scoped
		LEFT JOIN "gym-conversion-tracker"."sales" s ON s."attendance_id" = scoped."id"
		GROUP BY scoped."professor_id"
	)
		SELECT
			u."name" AS receptionist_name,
			p."name" AS professor_name,
			COUNT(DISTINCT scoped."id")::int AS attendances,
			COUNT(DISTINCT s."attendance_id")::int AS converted,
			COALESCE(SUM(s."amount_cents"), 0)::int AS revenue_cents,
			CASE WHEN pg.total = 0 THEN 0 ELSE pg.converted / pg.total END AS professor_global_conversion_rate
		FROM scoped
		JOIN "gym-conversion-tracker"."users" u ON u."id" = scoped."receptionist_id"
		JOIN "gym-conversion-tracker"."professors" p ON p."id" = scoped."professor_id"
		JOIN professor_global pg ON pg."professor_id" = scoped."professor_id"
		LEFT JOIN "gym-conversion-tracker"."sales" s ON s."attendance_id" = scoped."id"
		GROUP BY u."name", p."name", pg.total, pg.converted
		ORDER BY revenue_cents DESC, converted DESC
	`;

	const closers = await sql`
		SELECT
			u."id",
			u."name",
			COUNT(s."id")::int AS sales,
			COALESCE(SUM(s."amount_cents"), 0)::int AS revenue_cents
		FROM "gym-conversion-tracker"."sales" s
		JOIN "gym-conversion-tracker"."attendances" a ON a."id" = s."attendance_id"
		JOIN "gym-conversion-tracker"."users" u ON u."id" = s."sold_by_user_id"
		WHERE (${filters.academyId ?? null}::text IS NULL OR a."academy_id" = ${filters.academyId ?? null})
			AND (${from}::timestamptz IS NULL OR s."created_at" >= ${from}::timestamptz)
			AND (${to}::timestamptz IS NULL OR s."created_at" <= ${to}::timestamptz)
			AND (${filters.channel ?? null}::text IS NULL OR a."channel"::text = ${filters.channel ?? null})
			${scheduleScopeSql(filters)}
			AND (${restrictToReceptionist} = false OR s."sold_by_user_id" = ${user.id})
			AND (
				${isGlobal} = true OR a."academy_id" IN (
					SELECT "academy_id" FROM "gym-conversion-tracker"."user_academy_roles"
					WHERE "user_id" = ${user.id} AND "active" = true AND "academy_id" IS NOT NULL
				)
			)
		GROUP BY u."id", u."name"
		ORDER BY revenue_cents DESC
	`;

	const timeline = await sql`
		SELECT
			date_trunc('day', a."started_at" AT TIME ZONE 'America/Sao_Paulo')::date AS day,
			COUNT(DISTINCT a."id")::int AS attendances,
			COUNT(DISTINCT s."attendance_id")::int AS converted,
			COALESCE(SUM(s."amount_cents"), 0)::int AS revenue_cents
		FROM "gym-conversion-tracker"."attendances" a
		LEFT JOIN "gym-conversion-tracker"."sales" s ON s."attendance_id" = a."id"
		WHERE ${scope}
		GROUP BY day
		ORDER BY day
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
		timeline: withConversionRate([...timeline] as Array<{ attendances: number; converted: number; revenue_cents: number }>)
	});
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
				a."started_at",
				a."closed_at",
				a."status",
				l."name" AS lead_name,
				l."whatsapp_e164",
				u."name" AS receptionist_name,
				p."name" AS professor_name,
				s."label_snapshot",
				s."amount_cents",
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
		from: c.req.query('from') || undefined,
		to: c.req.query('to') || undefined,
		channel: c.req.query('channel') || undefined,
		weekdays: c.req.query('weekdays') || undefined,
		hourFrom: c.req.query('hourFrom') || undefined,
		hourTo: c.req.query('hourTo') || undefined
	});
}

type DashboardFilters = {
	academyId?: string;
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

function withConversionRate<T extends { attendances: number; converted: number }>(rows: T[]) {
	return rows.map((row) => ({
		...row,
		conversionRate: row.attendances ? row.converted / row.attendances : 0
	}));
}
