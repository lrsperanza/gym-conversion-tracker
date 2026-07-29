import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from '../db/client';
import { normalizeEmail, normalizeName, normalizePhone } from '../domain/normalize';
import { createWithUniqueOutcomeTypeKey } from '../domain/outcomeTypeKey';
import { assertCanAccessAcademy, canManageProfessor, canManageUserRole, hasAnyRole, requireAuth } from '../http/auth';
import { conflict, forbidden, notFound } from '../http/errors';
import {
	academyInputSchema,
	lossReasonInputSchema,
	outcomeTypeInputSchema,
	professorInputSchema,
	roleAssignmentSchema,
	userInputSchema
} from '../http/schemas';
import type { AppBindings, Role } from '../http/types';
import { hashPassword } from '../security/crypto';
import { audit } from '../services/audit';
import { createEmailToken } from '../services/emailTokens';
import { confirmationEmail } from '../services/mail';

export const adminRoutes = new Hono<AppBindings>();

adminRoutes.use('*', requireAuth);

adminRoutes.get('/academies', async (c) => {
	const user = c.get('user');
	const rows = hasAnyRole(user, ['ADMIN', 'SOCIO'])
		? await sql`SELECT * FROM "gym-conversion-tracker"."academies" ORDER BY "name"`
		: await sql`
			SELECT DISTINCT a.*
			FROM "gym-conversion-tracker"."academies" a
			JOIN "gym-conversion-tracker"."user_academy_roles" r ON r."academy_id" = a."id"
			WHERE r."user_id" = ${user.id} AND r."active" = true
			ORDER BY a."name"
		`;
	return c.json({ academies: rows });
});

adminRoutes.post('/academies', async (c) => {
	const user = c.get('user');
	if (!hasAnyRole(user, ['ADMIN', 'SOCIO', 'GERENTE_REGIONAL'])) throw forbidden();

	const input = academyInputSchema.parse(await c.req.json());
	const [academy] = await sql<Array<{ id: string }>>`
		INSERT INTO "gym-conversion-tracker"."academies" ("name", "city", "active")
		VALUES (${input.name}, ${input.city ?? null}, ${input.active ?? true})
		RETURNING *
	`;
	if (!academy) throw new Error('Falha ao criar academia.');
	await audit({ actorUserId: user.id, action: 'academy.create', entityType: 'academy', entityId: academy.id, payload: input, c });
	return c.json({ academy }, 201);
});

adminRoutes.patch('/academies/:id', async (c) => {
	const user = c.get('user');
	const id = c.req.param('id');
	if (!hasAnyRole(user, ['ADMIN', 'SOCIO', 'GERENTE_REGIONAL'])) throw forbidden();
	assertCanAccessAcademy(user, id);

	const input = academyInputSchema.partial().parse(await c.req.json());
	const [academy] = await sql<Array<{ id: string }>>`
		UPDATE "gym-conversion-tracker"."academies"
		SET
			"name" = COALESCE(${input.name ?? null}, "name"),
			"city" = COALESCE(${input.city ?? null}, "city"),
			"active" = COALESCE(${input.active ?? null}, "active"),
			"updated_at" = now()
		WHERE "id" = ${id}
		RETURNING *
	`;
	if (!academy) throw notFound();
	await audit({ actorUserId: user.id, action: 'academy.update', entityType: 'academy', entityId: id, payload: input, c });
	return c.json({ academy });
});

adminRoutes.get('/users', async (c) => {
	const user = c.get('user');
	const rows = hasAnyRole(user, ['ADMIN', 'SOCIO'])
		? await sql`
			SELECT u.*, COALESCE(json_agg(json_build_object('role', r."role", 'academyId', r."academy_id")) FILTER (WHERE r."id" IS NOT NULL), '[]') AS roles
			FROM "gym-conversion-tracker"."users" u
			LEFT JOIN "gym-conversion-tracker"."user_academy_roles" r ON r."user_id" = u."id" AND r."active" = true
			GROUP BY u."id"
			ORDER BY u."name"
		`
		: await sql`
			SELECT DISTINCT u.*, COALESCE(json_agg(json_build_object('role', r."role", 'academyId', r."academy_id")) FILTER (WHERE r."id" IS NOT NULL), '[]') AS roles
			FROM "gym-conversion-tracker"."users" u
			JOIN "gym-conversion-tracker"."user_academy_roles" visible ON visible."user_id" = u."id"
			LEFT JOIN "gym-conversion-tracker"."user_academy_roles" r ON r."user_id" = u."id" AND r."active" = true
			WHERE visible."academy_id" IN (
				SELECT "academy_id" FROM "gym-conversion-tracker"."user_academy_roles"
				WHERE "user_id" = ${user.id} AND "active" = true AND "academy_id" IS NOT NULL
			)
			GROUP BY u."id"
			ORDER BY u."name"
		`;

	return c.json({ users: rows });
});

adminRoutes.post('/users', async (c) => {
	const actor = c.get('user');
	const input = userInputSchema.parse(await c.req.json());
	const academyIds = input.roles.map((role) => role.academyId).filter((id): id is string => Boolean(id));

	for (const assignment of input.roles) {
		if (!canManageUserRole(actor, assignment.role, academyIds)) {
			throw forbidden(`Somente usuários autorizados podem cadastrar ${assignment.role}.`);
		}
		if (assignment.academyId) assertCanAccessAcademy(actor, assignment.academyId);
	}

	const phone = normalizePhone(input.phone);
	const email = normalizeEmail(input.email)!;
	const duplicate = await sql`
		SELECT "id" FROM "gym-conversion-tracker"."users"
		WHERE "email" = ${email} OR "whatsapp_e164" = ${phone.e164}
		LIMIT 1
	`;
	if (duplicate.length) throw conflict('Já existe usuário com este email ou WhatsApp.');

	const password = input.password || crypto.randomUUID();
	const passwordHash = await hashPassword(password);

	const [created] = await sql<Array<{ id: string; name: string; email: string }>>`
		INSERT INTO "gym-conversion-tracker"."users"
			("name", "normalized_name", "email", "whatsapp_country_code", "whatsapp_area_code", "whatsapp_number", "whatsapp_e164", "password_hash", "photo_mime", "photo_base64")
		VALUES (${input.name}, ${normalizeName(input.name)}, ${email}, ${phone.countryCode}, ${phone.areaCode}, ${phone.number}, ${phone.e164}, ${passwordHash}, ${input.photo?.mime ?? null}, ${input.photo?.base64 ?? null})
		RETURNING "id", "name", "email"
	`;
	if (!created) throw new Error('Falha ao criar usuário.');

	for (const assignment of input.roles) {
		await sql`
			INSERT INTO "gym-conversion-tracker"."user_academy_roles" ("user_id", "academy_id", "role")
			VALUES (${created.id}, ${assignment.academyId}, ${assignment.role})
			ON CONFLICT DO NOTHING
		`;
	}

	const token = await createEmailToken(created.id, 'EMAIL_CONFIRMATION', 60 * 24 * 7);
	let confirmationEmailSent = true;
	try {
		await confirmationEmail(created.email, created.name, token);
	} catch (error) {
		confirmationEmailSent = false;
		console.error(`Falha ao enviar confirmação do usuário ${created.id}.`, error);
	}
	await audit({
		actorUserId: actor.id,
		action: 'user.create',
		entityType: 'user',
		entityId: created.id,
		payload: { ...input, password: input.password ? 'provided' : 'generated' },
		c
	});

	return c.json(
		{
			user: { ...created, roles: input.roles, active: true },
			temporaryPassword: input.password ? undefined : password,
			confirmationEmailSent
		},
		201
	);
});

adminRoutes.patch('/users/:id', async (c) => {
	const actor = c.get('user');
	const id = c.req.param('id');
	const body = z
		.object({
			active: z.boolean().optional(),
			roles: z.array(roleAssignmentSchema).optional()
		})
		.parse(await c.req.json());

	if (body.roles) {
		for (const assignment of body.roles) {
			if (!canManageUserRole(actor, assignment.role, body.roles.map((role) => role.academyId).filter(Boolean) as string[])) {
				throw forbidden();
			}
			if (assignment.academyId) assertCanAccessAcademy(actor, assignment.academyId);
		}
		await sql`UPDATE "gym-conversion-tracker"."user_academy_roles" SET "active" = false WHERE "user_id" = ${id}`;
		for (const assignment of body.roles) {
			await sql`
				INSERT INTO "gym-conversion-tracker"."user_academy_roles" ("user_id", "academy_id", "role", "active")
				VALUES (${id}, ${assignment.academyId}, ${assignment.role}, true)
				ON CONFLICT DO NOTHING
			`;
		}
	}

	const [updated] = await sql`
		UPDATE "gym-conversion-tracker"."users"
		SET "active" = COALESCE(${body.active ?? null}, "active"), "updated_at" = now()
		WHERE "id" = ${id}
		RETURNING *
	`;
	if (!updated) throw notFound();
	await audit({ actorUserId: actor.id, action: 'user.update', entityType: 'user', entityId: id, payload: body, c });
	return c.json({ user: updated });
});

adminRoutes.get('/professors', async (c) => {
	const user = c.get('user');
	const academyId = c.req.query('academyId');
	if (academyId) assertCanAccessAcademy(user, academyId);

	const rows = academyId
		? await sql`SELECT * FROM "gym-conversion-tracker"."professors" WHERE "academy_id" = ${academyId} ORDER BY "name"`
		: hasAnyRole(user, ['ADMIN', 'SOCIO'])
			? await sql`SELECT * FROM "gym-conversion-tracker"."professors" ORDER BY "name"`
			: await sql`
				SELECT p.*
				FROM "gym-conversion-tracker"."professors" p
				WHERE p."academy_id" IN (
					SELECT "academy_id" FROM "gym-conversion-tracker"."user_academy_roles"
					WHERE "user_id" = ${user.id} AND "active" = true AND "academy_id" IS NOT NULL
				)
				ORDER BY p."name"
			`;
	return c.json({ professors: rows });
});

adminRoutes.post('/professors', async (c) => {
	const user = c.get('user');
	const input = professorInputSchema.parse(await c.req.json());
	if (!canManageProfessor(user, input.academyId, 'create')) throw forbidden();

	const phone = normalizePhone(input.phone);
	const [professor] = await sql<Array<{ id: string }>>`
		INSERT INTO "gym-conversion-tracker"."professors"
			("academy_id", "name", "normalized_name", "email", "whatsapp_country_code", "whatsapp_area_code", "whatsapp_number", "whatsapp_e164", "photo_mime", "photo_base64")
		VALUES (${input.academyId}, ${input.name}, ${normalizeName(input.name)}, ${normalizeEmail(input.email)}, ${phone.countryCode}, ${phone.areaCode}, ${phone.number}, ${phone.e164}, ${input.photo?.mime ?? null}, ${input.photo?.base64 ?? null})
		RETURNING *
	`;
	if (!professor) throw new Error('Falha ao criar professor.');
	await audit({ actorUserId: user.id, action: 'professor.create', entityType: 'professor', entityId: professor.id, payload: input, c });
	return c.json({ professor }, 201);
});

adminRoutes.patch('/professors/:id', async (c) => {
	const user = c.get('user');
	const id = c.req.param('id');
	const [current] = await sql<Array<{ academy_id: string }>>`
		SELECT "academy_id" FROM "gym-conversion-tracker"."professors" WHERE "id" = ${id}
	`;
	if (!current) throw notFound();
	if (!canManageProfessor(user, current.academy_id, 'update')) throw forbidden();

	const body = (await c.req.json()) as { active?: boolean };
	const [professor] = await sql`
		UPDATE "gym-conversion-tracker"."professors"
		SET "active" = COALESCE(${body.active ?? null}, "active"), "updated_at" = now()
		WHERE "id" = ${id}
		RETURNING *
	`;
	await audit({ actorUserId: user.id, action: 'professor.update', entityType: 'professor', entityId: id, payload: body, c });
	return c.json({ professor });
});

adminRoutes.get('/outcome-types', async (c) => {
	const rows = await sql`SELECT * FROM "gym-conversion-tracker"."outcome_types" ORDER BY "label"`;
	return c.json({ outcomeTypes: rows });
});

adminRoutes.post('/outcome-types', async (c) => {
	const user = c.get('user');
	if (!hasAnyRole(user, ['ADMIN', 'SOCIO', 'GERENTE_REGIONAL', 'LIDER'])) throw forbidden();
	const input = outcomeTypeInputSchema.parse(await c.req.json());
	const outcomeType = await createWithUniqueOutcomeTypeKey(async (key) => {
		const [row] = await sql`
			INSERT INTO "gym-conversion-tracker"."outcome_types"
				("key", "label", "kind", "current_value_cents", "requires_manual_value", "active")
			VALUES (${key}, ${input.label}, 'SALE', ${input.currentValueCents ?? null}, ${input.requiresManualValue ?? false}, ${input.active ?? true})
			ON CONFLICT ("key") DO NOTHING
			RETURNING *
		`;
		return row;
	});
	await audit({
		actorUserId: user.id,
		action: 'outcome_type.create',
		entityType: 'outcome_type',
		entityId: outcomeType.id,
		payload: input,
		c
	});
	return c.json({ outcomeType }, 201);
});

adminRoutes.patch('/outcome-types/:id', async (c) => {
	const user = c.get('user');
	if (!hasAnyRole(user, ['ADMIN', 'SOCIO', 'GERENTE_REGIONAL', 'LIDER'])) throw forbidden();
	const input = outcomeTypeInputSchema.partial().parse(await c.req.json());
	const [row] = await sql`
		UPDATE "gym-conversion-tracker"."outcome_types"
		SET
			"label" = COALESCE(${input.label ?? null}, "label"),
			"current_value_cents" = COALESCE(${input.currentValueCents ?? null}, "current_value_cents"),
			"requires_manual_value" = COALESCE(${input.requiresManualValue ?? null}, "requires_manual_value"),
			"active" = COALESCE(${input.active ?? null}, "active"),
			"updated_at" = now()
		WHERE "id" = ${c.req.param('id')}
		RETURNING *
	`;
	if (!row) throw notFound();
	await audit({ actorUserId: user.id, action: 'outcome_type.update', entityType: 'outcome_type', entityId: c.req.param('id'), payload: input, c });
	return c.json({ outcomeType: row });
});

adminRoutes.get('/loss-reasons', async (c) => {
	const rows = await sql`SELECT * FROM "gym-conversion-tracker"."loss_reasons" ORDER BY "label"`;
	return c.json({ lossReasons: rows });
});

adminRoutes.post('/loss-reasons', async (c) => {
	const user = c.get('user');
	if (!hasAnyRole(user, ['ADMIN', 'SOCIO', 'GERENTE_REGIONAL', 'LIDER'])) throw forbidden();
	const input = lossReasonInputSchema.parse(await c.req.json());
	const [row] = await sql`
		INSERT INTO "gym-conversion-tracker"."loss_reasons" ("label", "category", "requires_description", "active")
		VALUES (${input.label}, ${input.category}, ${input.requiresDescription ?? false}, ${input.active ?? true})
		RETURNING *
	`;
	if (!row) throw new Error('Falha ao criar motivo de perda.');
	await audit({ actorUserId: user.id, action: 'loss_reason.create', entityType: 'loss_reason', entityId: row.id, payload: input, c });
	return c.json({ lossReason: row }, 201);
});

adminRoutes.patch('/loss-reasons/:id', async (c) => {
	const user = c.get('user');
	if (!hasAnyRole(user, ['ADMIN', 'SOCIO', 'GERENTE_REGIONAL', 'LIDER'])) throw forbidden();
	const input = lossReasonInputSchema.partial().parse(await c.req.json());
	const [row] = await sql`
		UPDATE "gym-conversion-tracker"."loss_reasons"
		SET
			"label" = COALESCE(${input.label ?? null}, "label"),
			"category" = COALESCE(${input.category ?? null}, "category"),
			"requires_description" = COALESCE(${input.requiresDescription ?? null}, "requires_description"),
			"active" = COALESCE(${input.active ?? null}, "active"),
			"updated_at" = now()
		WHERE "id" = ${c.req.param('id')}
		RETURNING *
	`;
	if (!row) throw notFound();
	await audit({ actorUserId: user.id, action: 'loss_reason.update', entityType: 'loss_reason', entityId: c.req.param('id'), payload: input, c });
	return c.json({ lossReason: row });
});

