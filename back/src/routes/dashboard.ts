import { Hono } from 'hono';
import { sql } from '../db/client';
import { assertCanAccessAcademy, hasAnyRole, requireAuth } from '../http/auth';
import { dashboardQuerySchema } from '../http/schemas';
import type { AppBindings } from '../http/types';

export const dashboardRoutes = new Hono<AppBindings>();

dashboardRoutes.use('*', requireAuth);

dashboardRoutes.get('/dashboard/summary', async (c) => {
	const user = c.get('user');
	const filters = dashboardQuerySchema.parse({
		academyId: c.req.query('academyId'),
		from: c.req.query('from'),
		to: c.req.query('to')
	});
	if (filters.academyId) assertCanAccessAcademy(user, filters.academyId);

	const from = filters.from ? new Date(filters.from).toISOString() : null;
	const to = filters.to ? new Date(filters.to).toISOString() : null;
	const isGlobal = hasAnyRole(user, ['ADMIN', 'SOCIO']);
	const isManager = hasAnyRole(user, ['GERENTE_REGIONAL', 'LIDER']);
	const restrictToReceptionist = !isGlobal && !isManager;

	const [kpi] = await sql<Array<{ attendances: number; converted: number; revenue_cents: number }>>`
		WITH scoped AS (
			SELECT a.*
			FROM "gym-conversion-tracker"."attendances" a
			WHERE (${filters.academyId ?? null}::text IS NULL OR a."academy_id" = ${filters.academyId ?? null})
				AND (${from}::timestamptz IS NULL OR a."started_at" >= ${from}::timestamptz)
				AND (${to}::timestamptz IS NULL OR a."started_at" <= ${to}::timestamptz)
				AND (${restrictToReceptionist} = false OR a."receptionist_id" = ${user.id})
				AND (
					${isGlobal} = true OR a."academy_id" IN (
						SELECT "academy_id" FROM "gym-conversion-tracker"."user_academy_roles"
						WHERE "user_id" = ${user.id} AND "active" = true AND "academy_id" IS NOT NULL
					)
				)
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
			WHERE (${filters.academyId ?? null}::text IS NULL OR a."academy_id" = ${filters.academyId ?? null})
				AND (${from}::timestamptz IS NULL OR a."started_at" >= ${from}::timestamptz)
				AND (${to}::timestamptz IS NULL OR a."started_at" <= ${to}::timestamptz)
				AND (${restrictToReceptionist} = false OR a."receptionist_id" = ${user.id})
				AND (
					${isGlobal} = true OR a."academy_id" IN (
						SELECT "academy_id" FROM "gym-conversion-tracker"."user_academy_roles"
						WHERE "user_id" = ${user.id} AND "active" = true AND "academy_id" IS NOT NULL
					)
				)
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
				AND (${filters.academyId ?? null}::text IS NULL OR a."academy_id" = ${filters.academyId ?? null})
				AND (${from}::timestamptz IS NULL OR a."started_at" >= ${from}::timestamptz)
				AND (${to}::timestamptz IS NULL OR a."started_at" <= ${to}::timestamptz)
				AND (${restrictToReceptionist} = false OR a."receptionist_id" = ${user.id})
				AND (
					${isGlobal} = true OR a."academy_id" IN (
						SELECT "academy_id" FROM "gym-conversion-tracker"."user_academy_roles"
						WHERE "user_id" = ${user.id} AND "active" = true AND "academy_id" IS NOT NULL
					)
				)
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
				AND (${filters.academyId ?? null}::text IS NULL OR a."academy_id" = ${filters.academyId ?? null})
				AND (${from}::timestamptz IS NULL OR a."started_at" >= ${from}::timestamptz)
				AND (${to}::timestamptz IS NULL OR a."started_at" <= ${to}::timestamptz)
				AND (${restrictToReceptionist} = false OR a."receptionist_id" = ${user.id})
				AND (
					${isGlobal} = true OR a."academy_id" IN (
						SELECT "academy_id" FROM "gym-conversion-tracker"."user_academy_roles"
						WHERE "user_id" = ${user.id} AND "active" = true AND "academy_id" IS NOT NULL
					)
				)
		), professor_global AS (
			SELECT "professor_id", COUNT(DISTINCT "id")::float AS total, COUNT(DISTINCT s."attendance_id")::float AS converted
			FROM scoped
			LEFT JOIN "gym-conversion-tracker"."sales" s ON s."attendance_id" = scoped."id"
			GROUP BY "professor_id"
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
		WHERE (${filters.academyId ?? null}::text IS NULL OR a."academy_id" = ${filters.academyId ?? null})
			AND (${from}::timestamptz IS NULL OR a."started_at" >= ${from}::timestamptz)
			AND (${to}::timestamptz IS NULL OR a."started_at" <= ${to}::timestamptz)
			AND (${restrictToReceptionist} = false OR a."receptionist_id" = ${user.id})
			AND (
				${isGlobal} = true OR a."academy_id" IN (
					SELECT "academy_id" FROM "gym-conversion-tracker"."user_academy_roles"
					WHERE "user_id" = ${user.id} AND "active" = true AND "academy_id" IS NOT NULL
				)
			)
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
	const academyId = c.req.query('academyId');
	if (academyId) assertCanAccessAcademy(user, academyId);
	const isGlobal = hasAnyRole(user, ['ADMIN', 'SOCIO']);
	const isManager = hasAnyRole(user, ['GERENTE_REGIONAL', 'LIDER']);

	const rows = await sql`
		SELECT
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
		WHERE (${academyId ?? null}::text IS NULL OR a."academy_id" = ${academyId ?? null})
			AND (${!isGlobal && !isManager} = false OR a."receptionist_id" = ${user.id})
			AND (
				${isGlobal} = true OR a."academy_id" IN (
					SELECT "academy_id" FROM "gym-conversion-tracker"."user_academy_roles"
					WHERE "user_id" = ${user.id} AND "active" = true AND "academy_id" IS NOT NULL
				)
			)
		ORDER BY a."started_at" DESC
		LIMIT 500
	`;

	return c.json({ rows });
});

function withConversionRate<T extends { attendances: number; converted: number }>(rows: T[]) {
	return rows.map((row) => ({
		...row,
		conversionRate: row.attendances ? row.converted / row.attendances : 0
	}));
}

