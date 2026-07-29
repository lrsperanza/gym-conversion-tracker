import { Hono } from 'hono';
import { sql } from '../db/client';
import { normalizeEmail, normalizeName, normalizePhone } from '../domain/normalize';
import { assertCanAccessAcademy, hasAnyRole, requireAuth } from '../http/auth';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import {
	attendanceEventInputSchema,
	attendanceInputSchema,
	attendancePatchSchema,
	leadPatchSchema
} from '../http/schemas';
import type { AppBindings } from '../http/types';
import { audit } from '../services/audit';

export const attendanceRoutes = new Hono<AppBindings>();

attendanceRoutes.use('*', requireAuth);

attendanceRoutes.get('/leads/duplicates', async (c) => {
	const user = c.get('user');
	const name = c.req.query('name') || '';
	const email = normalizeEmail(c.req.query('email'));
	const phoneNumber = c.req.query('phoneNumber');
	const phone = phoneNumber
		? normalizePhone({
				countryCode: c.req.query('countryCode') || '55',
				areaCode: c.req.query('areaCode') || '16',
				number: phoneNumber
			})
		: null;

	const exact = await sql`
		SELECT *
		FROM "gym-conversion-tracker"."leads"
		WHERE (${phone?.e164 ?? null}::text IS NOT NULL AND "whatsapp_e164" = ${phone?.e164 ?? null})
			OR (${email ?? null}::text IS NOT NULL AND "email" = ${email})
		LIMIT 10
	`;

	const normalizedName = normalizeName(name);
	const probable = normalizedName
		? await sql`
			SELECT *, similarity("normalized_name", ${normalizedName}) AS score
			FROM "gym-conversion-tracker"."leads"
			WHERE "normalized_name" % ${normalizedName}
			ORDER BY score DESC
			LIMIT 10
		`
		: [];

	await audit({ actorUserId: user.id, action: 'lead.duplicate_check', entityType: 'lead', payload: { name, email, phone: phone?.e164 }, c });
	return c.json({ exact, probable });
});

attendanceRoutes.get('/attendances', async (c) => {
	const user = c.get('user');
	const academyId = c.req.query('academyId');
	const status = c.req.query('status');
	if (academyId) assertCanAccessAcademy(user, academyId);

	const rows = hasAnyRole(user, ['ADMIN', 'SOCIO', 'GERENTE_REGIONAL', 'LIDER'])
		? await sql`
			SELECT a.*, l."name" AS lead_name, l."whatsapp_e164", l."email" AS lead_email, p."name" AS professor_name, u."name" AS receptionist_name
			FROM "gym-conversion-tracker"."attendances" a
			JOIN "gym-conversion-tracker"."leads" l ON l."id" = a."lead_id"
			JOIN "gym-conversion-tracker"."users" u ON u."id" = a."receptionist_id"
			LEFT JOIN "gym-conversion-tracker"."professors" p ON p."id" = a."professor_id"
			WHERE (${academyId ?? null}::text IS NULL OR a."academy_id" = ${academyId ?? null})
				AND (${status ?? null}::text IS NULL OR a."status" = ${status ?? null})
				AND (
					${hasAnyRole(user, ['ADMIN', 'SOCIO'])} = true OR
					a."academy_id" IN (
						SELECT "academy_id" FROM "gym-conversion-tracker"."user_academy_roles"
						WHERE "user_id" = ${user.id} AND "active" = true AND "academy_id" IS NOT NULL
					)
				)
			ORDER BY a."started_at" DESC
			LIMIT 200
		`
		: await sql`
			SELECT a.*, l."name" AS lead_name, l."whatsapp_e164", l."email" AS lead_email, p."name" AS professor_name, u."name" AS receptionist_name
			FROM "gym-conversion-tracker"."attendances" a
			JOIN "gym-conversion-tracker"."leads" l ON l."id" = a."lead_id"
			JOIN "gym-conversion-tracker"."users" u ON u."id" = a."receptionist_id"
			LEFT JOIN "gym-conversion-tracker"."professors" p ON p."id" = a."professor_id"
			WHERE a."receptionist_id" = ${user.id}
				AND (${academyId ?? null}::text IS NULL OR a."academy_id" = ${academyId ?? null})
				AND (${status ?? null}::text IS NULL OR a."status" = ${status ?? null})
			ORDER BY a."started_at" DESC
			LIMIT 200
		`;

	return c.json({ attendances: rows });
});

attendanceRoutes.post('/attendances', async (c) => {
	const user = c.get('user');
	const input = attendanceInputSchema.parse(await c.req.json());
	assertCanAccessAcademy(user, input.academyId);
	if (input.presenter === 'PROFESSOR' && !input.professorId) {
		throw badRequest('Selecione o professor que apresentou a academia.');
	}

	const phone = input.lead.phone?.number ? normalizePhone(input.lead.phone) : null;
	const email = normalizeEmail(input.lead.email);

	if (!input.leadId && (phone || email)) {
		const [duplicate] = await sql`
			SELECT "id", "name", "whatsapp_e164", "email"
			FROM "gym-conversion-tracker"."leads"
			WHERE (${phone?.e164 ?? null}::text IS NOT NULL AND "whatsapp_e164" = ${phone?.e164 ?? null})
				OR (${email}::text IS NOT NULL AND "email" = ${email})
			LIMIT 1
		`;
		if (duplicate) throw conflict('Provável duplicidade encontrada. Use o lead existente ou revise o atendimento.', duplicate);
	}

	const result = await sql.begin(async (tx) => {
		const [lead] = input.leadId
			? await tx`SELECT "id" FROM "gym-conversion-tracker"."leads" WHERE "id" = ${input.leadId}`
			: await tx<Array<{ id: string }>>`
				INSERT INTO "gym-conversion-tracker"."leads"
					("name", "normalized_name", "email", "whatsapp_country_code", "whatsapp_area_code", "whatsapp_number", "whatsapp_e164", "notes")
				VALUES (${input.lead.name}, ${normalizeName(input.lead.name)}, ${email}, ${phone?.countryCode ?? '55'}, ${phone?.areaCode ?? '16'}, ${phone?.number ?? null}, ${phone?.e164 ?? null}, ${input.lead.notes ?? null})
				RETURNING "id"
			`;
		if (!lead) throw notFound('Lead não encontrado.');

		const [attendance] = await tx<Array<{ id: string }>>`
			INSERT INTO "gym-conversion-tracker"."attendances"
				("academy_id", "lead_id", "receptionist_id", "professor_id", "presenter", "status")
			VALUES (${input.academyId}, ${lead.id}, ${user.id}, ${input.professorId ?? null}, ${input.presenter}, ${input.status})
			RETURNING *
		`;
		if (!attendance) throw new Error('Falha ao criar atendimento.');

		await tx`
			INSERT INTO "gym-conversion-tracker"."attendance_events"
				("attendance_id", "actor_user_id", "type", "description")
			VALUES (${attendance.id}, ${user.id}, ${input.presenter === 'PROFESSOR' ? 'TOUR_PROFESSOR' : 'TOUR_RECEPTIONIST'}, 'Atendimento aberto')
		`;

		return attendance;
	});

	await audit({ actorUserId: user.id, action: 'attendance.create', entityType: 'attendance', entityId: result.id, payload: input, c });
	return c.json({ attendance: result }, 201);
});

attendanceRoutes.get('/attendances/:id', async (c) => {
	const user = c.get('user');
	const id = c.req.param('id');
	const [attendance] = await sql<Array<{ academy_id: string; receptionist_id: string }>>`
		SELECT a.*, row_to_json(l.*) AS lead, row_to_json(p.*) AS professor, row_to_json(u.*) AS receptionist
		FROM "gym-conversion-tracker"."attendances" a
		JOIN "gym-conversion-tracker"."leads" l ON l."id" = a."lead_id"
		JOIN "gym-conversion-tracker"."users" u ON u."id" = a."receptionist_id"
		LEFT JOIN "gym-conversion-tracker"."professors" p ON p."id" = a."professor_id"
		WHERE a."id" = ${id}
	`;
	if (!attendance) throw notFound();
	if (attendance.receptionist_id !== user.id) assertCanAccessAcademy(user, attendance.academy_id);

	const events = await sql`
		SELECT e.*, u."name" AS actor_name
		FROM "gym-conversion-tracker"."attendance_events" e
		JOIN "gym-conversion-tracker"."users" u ON u."id" = e."actor_user_id"
		WHERE e."attendance_id" = ${id}
		ORDER BY e."created_at"
	`;
	const sales = await sql`SELECT * FROM "gym-conversion-tracker"."sales" WHERE "attendance_id" = ${id}`;
	const losses = await sql`
		SELECT al.*, lr."label", lr."category"
		FROM "gym-conversion-tracker"."attendance_losses" al
		JOIN "gym-conversion-tracker"."loss_reasons" lr ON lr."id" = al."loss_reason_id"
		WHERE al."attendance_id" = ${id}
	`;
	return c.json({ attendance, events, sales, losses });
});

attendanceRoutes.patch('/attendances/:id', async (c) => {
	const user = c.get('user');
	const id = c.req.param('id');
	const input = attendancePatchSchema.parse(await c.req.json());

	const [attendance] = await sql<
		Array<{ id: string; academy_id: string; receptionist_id: string; professor_id: string | null; presenter: string }>
	>`
		SELECT "id", "academy_id", "receptionist_id", "professor_id", "presenter"
		FROM "gym-conversion-tracker"."attendances"
		WHERE "id" = ${id}
	`;
	if (!attendance) throw notFound();
	if (attendance.receptionist_id !== user.id) assertCanAccessAcademy(user, attendance.academy_id);

	const updates: Record<string, string | null> = {};
	if ('professorId' in input) {
		if (input.professorId) {
			const [professor] = await sql<Array<{ id: string }>>`
				SELECT "id" FROM "gym-conversion-tracker"."professors"
				WHERE "id" = ${input.professorId} AND "academy_id" = ${attendance.academy_id} AND "active" = true
			`;
			if (!professor) throw badRequest('Professor inválido para esta academia.');
		}
		updates.professor_id = input.professorId ?? null;
	}
	const nextPresenter = input.presenter ?? attendance.presenter;
	const nextProfessorId = 'professor_id' in updates ? updates.professor_id : attendance.professor_id;
	if (nextPresenter === 'PROFESSOR' && !nextProfessorId) {
		throw badRequest('Selecione o professor que apresentou a academia.');
	}
	if ('presenter' in input) updates.presenter = nextPresenter;
	if (!Object.keys(updates).length) throw badRequest('Nada para atualizar.');

	const [updated] = await sql`
		UPDATE "gym-conversion-tracker"."attendances"
		SET ${sql(updates)}, "updated_at" = now()
		WHERE "id" = ${id}
		RETURNING *
	`;

	await audit({ actorUserId: user.id, action: 'attendance.update', entityType: 'attendance', entityId: id, payload: input, c });
	return c.json({ attendance: updated });
});

attendanceRoutes.patch('/leads/:id', async (c) => {
	const user = c.get('user');
	const id = c.req.param('id');
	const input = leadPatchSchema.parse(await c.req.json());

	const [lead] = await sql<Array<{ id: string }>>`
		SELECT "id" FROM "gym-conversion-tracker"."leads" WHERE "id" = ${id}
	`;
	if (!lead) throw notFound('Lead não encontrado.');

	if (!hasAnyRole(user, ['ADMIN', 'SOCIO'])) {
		const reachable = await sql`
			SELECT 1
			FROM "gym-conversion-tracker"."attendances" a
			WHERE a."lead_id" = ${id}
				AND (
					a."receptionist_id" = ${user.id}
					OR a."academy_id" IN (
						SELECT "academy_id" FROM "gym-conversion-tracker"."user_academy_roles"
						WHERE "user_id" = ${user.id} AND "active" = true AND "academy_id" IS NOT NULL
					)
				)
			LIMIT 1
		`;
		if (!reachable.length) throw forbidden('Você não tem acesso a este lead.');
	}

	const updates: Record<string, string | null> = {};
	if (input.name) {
		updates.name = input.name;
		updates.normalized_name = normalizeName(input.name);
	}
	if ('email' in input) updates.email = normalizeEmail(input.email);
	if ('phone' in input) {
		if (input.phone === null) {
			updates.whatsapp_number = null;
			updates.whatsapp_e164 = null;
		} else if (input.phone) {
			const phone = normalizePhone(input.phone);
			updates.whatsapp_country_code = phone.countryCode;
			updates.whatsapp_area_code = phone.areaCode;
			updates.whatsapp_number = phone.number;
			updates.whatsapp_e164 = phone.e164;
		}
	}
	if ('notes' in input) updates.notes = input.notes ?? null;
	if (!Object.keys(updates).length) throw badRequest('Nada para atualizar.');

	if (updates.whatsapp_e164 || updates.email) {
		const [duplicate] = await sql`
			SELECT "id", "name", "whatsapp_e164", "email"
			FROM "gym-conversion-tracker"."leads"
			WHERE "id" <> ${id}
				AND (
					(${updates.whatsapp_e164 ?? null}::text IS NOT NULL AND "whatsapp_e164" = ${updates.whatsapp_e164 ?? null})
					OR (${updates.email ?? null}::text IS NOT NULL AND "email" = ${updates.email ?? null})
				)
			LIMIT 1
		`;
		if (duplicate) throw conflict('Outro lead já usa este telefone ou email.', duplicate);
	}

	const [updated] = await sql`
		UPDATE "gym-conversion-tracker"."leads"
		SET ${sql(updates)}, "updated_at" = now()
		WHERE "id" = ${id}
		RETURNING *
	`;

	await audit({ actorUserId: user.id, action: 'lead.update', entityType: 'lead', entityId: id, payload: input, c });
	return c.json({ lead: updated });
});

attendanceRoutes.post('/attendances/:id/events', async (c) => {
	const user = c.get('user');
	const attendanceId = c.req.param('id');
	const input = attendanceEventInputSchema.parse(await c.req.json());
	const [attendance] = await sql<
		Array<{
			id: string;
			academy_id: string;
			receptionist_id: string;
			professor_id: string | null;
			status: string;
		}>
	>`
		SELECT "id", "academy_id", "receptionist_id", "professor_id", "status"
		FROM "gym-conversion-tracker"."attendances"
		WHERE "id" = ${attendanceId}
	`;
	if (!attendance) throw notFound();
	if (attendance.receptionist_id !== user.id) assertCanAccessAcademy(user, attendance.academy_id);

	const result = await sql.begin(async (tx) => {
		if (input.type === 'REOPEN') {
			const [event] = await tx<Array<{ id: string }>>`
				INSERT INTO "gym-conversion-tracker"."attendance_events" ("attendance_id", "actor_user_id", "type", "description")
				VALUES (${attendanceId}, ${user.id}, 'REOPEN', ${input.description ?? null})
				RETURNING *
			`;
			if (!event) throw new Error('Falha ao reabrir atendimento.');
			await tx`UPDATE "gym-conversion-tracker"."attendances" SET "status" = 'IN_PROGRESS', "closed_at" = NULL, "updated_at" = now() WHERE "id" = ${attendanceId}`;
			return event;
		}

		if (input.type === 'SALE') {
			const saleInfo = await resolveSale(input.outcomeTypeId ?? null, input.manualLabel, input.manualValueCents);
			const [event] = await tx<Array<{ id: string }>>`
				INSERT INTO "gym-conversion-tracker"."attendance_events" ("attendance_id", "actor_user_id", "type", "description")
				VALUES (${attendanceId}, ${user.id}, 'SALE', ${saleInfo.label})
				RETURNING *
			`;
			if (!event) throw new Error('Falha ao registrar venda.');
			await tx`
				INSERT INTO "gym-conversion-tracker"."sales"
					("attendance_id", "event_id", "outcome_type_id", "sold_by_user_id", "original_receptionist_id", "original_professor_id", "label_snapshot", "amount_cents")
				VALUES (${attendanceId}, ${event.id}, ${saleInfo.outcomeTypeId}, ${user.id}, ${attendance.receptionist_id}, ${attendance.professor_id}, ${saleInfo.label}, ${saleInfo.amountCents})
			`;
			await tx`UPDATE "gym-conversion-tracker"."attendances" SET "status" = 'FINALIZED', "closed_at" = now(), "updated_at" = now() WHERE "id" = ${attendanceId}`;
			return event;
		}

		if (input.type === 'LOSS') {
			const [reason] = await tx<Array<{ id: string; requires_description: boolean }>>`
				SELECT "id", "requires_description"
				FROM "gym-conversion-tracker"."loss_reasons"
				WHERE "id" = ${input.lossReasonId} AND "active" = true
			`;
			if (!reason) throw badRequest('Motivo de perda inválido.');
			if (reason.requires_description && !input.description) throw badRequest('Descreva o motivo de perda.');

			const [event] = await tx<Array<{ id: string }>>`
				INSERT INTO "gym-conversion-tracker"."attendance_events" ("attendance_id", "actor_user_id", "type", "description")
				VALUES (${attendanceId}, ${user.id}, 'LOSS', ${input.description ?? null})
				RETURNING *
			`;
			if (!event) throw new Error('Falha ao registrar perda.');
			await tx`
				INSERT INTO "gym-conversion-tracker"."attendance_losses" ("attendance_id", "event_id", "loss_reason_id", "description")
				VALUES (${attendanceId}, ${event.id}, ${input.lossReasonId}, ${input.description ?? null})
			`;
			await tx`UPDATE "gym-conversion-tracker"."attendances" SET "status" = 'FINALIZED', "closed_at" = now(), "updated_at" = now() WHERE "id" = ${attendanceId}`;
			return event;
		}

		const scheduledFor =
			input.type === 'EXPERIMENTAL_CLASS_SCHEDULED' || input.type === 'FOLLOW_UP_SCHEDULED'
				? new Date(input.scheduledFor).toISOString()
				: null;
		const [event] = await tx<Array<{ id: string }>>`
			INSERT INTO "gym-conversion-tracker"."attendance_events" ("attendance_id", "actor_user_id", "type", "scheduled_for", "description")
			VALUES (${attendanceId}, ${user.id}, ${input.type}, ${scheduledFor}::timestamptz, ${'description' in input ? input.description ?? null : null})
			RETURNING *
		`;
		if (!event) throw new Error('Falha ao registrar evento.');
		const nextStatus = scheduledFor ? 'PENDING' : attendance.status;
		await tx`UPDATE "gym-conversion-tracker"."attendances" SET "status" = ${nextStatus}, "updated_at" = now() WHERE "id" = ${attendanceId}`;
		return event;
	});

	await audit({ actorUserId: user.id, action: 'attendance.event.create', entityType: 'attendance', entityId: attendanceId, payload: input, c });
	return c.json({ event: result }, 201);
});

async function resolveSale(outcomeTypeId: string | null, manualLabel?: string, manualValueCents?: number) {
	if (!outcomeTypeId) {
		if (!manualLabel || manualValueCents === undefined) throw badRequest('Informe plano e valor da venda.');
		return { outcomeTypeId: null, label: manualLabel, amountCents: manualValueCents };
	}

	const [outcome] = await sql<
		Array<{ id: string; label: string; current_value_cents: number | null; requires_manual_value: boolean }>
	>`
		SELECT "id", "label", "current_value_cents", "requires_manual_value"
		FROM "gym-conversion-tracker"."outcome_types"
		WHERE "id" = ${outcomeTypeId} AND "active" = true
	`;
	if (!outcome) throw badRequest('Plano inválido.');

	if (outcome.requires_manual_value) {
		if (!manualLabel || manualValueCents === undefined) throw badRequest('Informe descrição e valor para “Outro”.');
		return { outcomeTypeId, label: manualLabel, amountCents: manualValueCents };
	}

	if (outcome.current_value_cents === null) throw badRequest('Configure o valor atual do plano antes de vendê-lo.');
	return { outcomeTypeId, label: outcome.label, amountCents: outcome.current_value_cents };
}

