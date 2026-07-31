import { Hono } from 'hono';
import type { Context } from 'hono';
import { sql } from '../db/client';
import { assertCanAccessAcademy, requireAuth } from '../http/auth';
import { AppError, notFound, unauthorized } from '../http/errors';
import { evoCredentialsSchema } from '../http/schemas';
import type { AppBindings, SessionUser } from '../http/types';
import { decryptEvoPassword, encryptEvoPassword } from '../security/evoCrypto';
import { createEvoTicket, verifyEvoTicket } from '../security/evoTicket';

export const evoRoutes = new Hono<AppBindings>();

type PayloadUser =
	| { trustedTicket: true; user: { id: string } }
	| { trustedTicket: false; user: SessionUser };

evoRoutes.get('/credentials', requireAuth, async (c) => {
	const user = c.get('user');
	const [row] = await sql<Array<{ evo_username: string | null; evo_password_encrypted: string | null }>>`
		SELECT "evo_username", "evo_password_encrypted"
		FROM "gym-conversion-tracker"."users"
		WHERE "id" = ${user.id}
	`;

	return c.json({
		configured: Boolean(row?.evo_username && row?.evo_password_encrypted),
		username: row?.evo_username ?? null
	});
});

evoRoutes.put('/credentials', requireAuth, async (c) => {
	const user = c.get('user');
	const input = evoCredentialsSchema.parse(await c.req.json());
	const encryptedPassword = encryptEvoPassword(input.password);

	const [updated] = await sql`
		UPDATE "gym-conversion-tracker"."users"
		SET "evo_username" = ${input.username},
			"evo_password_encrypted" = ${encryptedPassword},
			"updated_at" = now()
		WHERE "id" = ${user.id}
		RETURNING "evo_username"
	`;
	if (!updated) throw notFound('Usuário não encontrado.');

	return c.json({ configured: true, username: input.username });
});

evoRoutes.delete('/credentials', requireAuth, async (c) => {
	const user = c.get('user');
	await sql`
		UPDATE "gym-conversion-tracker"."users"
		SET "evo_username" = NULL,
			"evo_password_encrypted" = NULL,
			"updated_at" = now()
		WHERE "id" = ${user.id}
	`;

	return c.json({ ok: true });
});

evoRoutes.post('/attendances/:id/ticket', requireAuth, async (c) => {
	const user = c.get('user');
	const attendanceId = c.req.param('id');
	await assertAttendanceAccess(user, attendanceId);

	return c.json(createEvoTicket(attendanceId, user.id));
});

evoRoutes.get('/attendances/:id/payload', async (c) => {
	const attendanceId = c.req.param('id');
	const payloadUser = await resolvePayloadUser(c, attendanceId);
	const [attendance] = await sql<
		Array<{
			id: string;
			academy_id: string;
			receptionist_id: string;
			academy_name: string;
			evo_unit_name: string | null;
			lead_name: string;
			lead_surname: string | null;
			lead_cpf: string | null;
			lead_birth_date: string | Date | null;
			lead_gender: string | null;
			lead_cep: string | null;
			lead_visit_type: string | null;
			lead_how_found_us: string | null;
			lead_email: string | null;
			whatsapp_country_code: string | null;
			whatsapp_area_code: string | null;
			whatsapp_number: string | null;
			whatsapp_e164: string | null;
			evo_username: string | null;
			evo_password_encrypted: string | null;
		}>
	>`
		SELECT a."id", a."academy_id", a."receptionist_id",
			ac."name" AS academy_name, ac."evo_unit_name",
			l."name" AS lead_name, l."surname" AS lead_surname, l."cpf" AS lead_cpf,
			l."birth_date" AS lead_birth_date, l."gender" AS lead_gender, l."cep" AS lead_cep,
			l."visit_type" AS lead_visit_type, l."how_found_us" AS lead_how_found_us,
			l."email" AS lead_email, l."whatsapp_country_code", l."whatsapp_area_code",
			l."whatsapp_number", l."whatsapp_e164",
			u."evo_username", u."evo_password_encrypted"
		FROM "gym-conversion-tracker"."attendances" a
		JOIN "gym-conversion-tracker"."academies" ac ON ac."id" = a."academy_id"
		JOIN "gym-conversion-tracker"."leads" l ON l."id" = a."lead_id"
		JOIN "gym-conversion-tracker"."users" u ON u."id" = ${payloadUser.user.id}
		WHERE a."id" = ${attendanceId}
	`;
	if (!attendance) throw notFound('Atendimento não encontrado.');
	if (!payloadUser.trustedTicket && attendance.receptionist_id !== payloadUser.user.id) {
		assertCanAccessAcademy(payloadUser.user, attendance.academy_id);
	}

	const missing = missingEvoFields(attendance);
	if (missing.length) {
		throw new AppError(422, 'Informe o nome do aluno e as credenciais do EVO antes de enviar.', 'EVO_INCOMPLETE', missing);
	}

	return c.json({
		credenciais: {
			usuario: attendance.evo_username!,
			senha: decryptEvoPassword(attendance.evo_password_encrypted!)
		},
		unidade: attendance.evo_unit_name || attendance.academy_name,
		prospect: {
			nome: attendance.lead_name,
			sobrenome: texto(attendance.lead_surname),
			cpf: digits(attendance.lead_cpf),
			nascimento: attendance.lead_birth_date
				? toBrazilianDate(attendance.lead_birth_date)
				: undefined,
			genero: texto(attendance.lead_gender),
			cep: digits(attendance.lead_cep),
			ddi: digits(attendance.whatsapp_country_code),
			telefone: telefoneComDdd(attendance) ?? texto(attendance.whatsapp_e164),
			email: texto(attendance.lead_email),
			tipoVisita: texto(attendance.lead_visit_type),
			comoConheceu: texto(attendance.lead_how_found_us)
		}
	});
});

async function resolvePayloadUser(c: Context<AppBindings>, attendanceId: string): Promise<PayloadUser> {
	const ticket = bearerToken(c.req.header('authorization'));
	if (ticket) {
		const payload = verifyEvoTicket(ticket, attendanceId);
		if (!payload) throw unauthorized('Ticket EVO inválido ou expirado.');
		return { user: { id: payload.userId }, trustedTicket: true };
	}

	await requireAuth(c, async () => undefined);
	return { user: c.get('user'), trustedTicket: false };
}

async function assertAttendanceAccess(user: SessionUser, attendanceId: string) {
	const [attendance] = await sql<Array<{ academy_id: string; receptionist_id: string }>>`
		SELECT "academy_id", "receptionist_id"
		FROM "gym-conversion-tracker"."attendances"
		WHERE "id" = ${attendanceId}
	`;
	if (!attendance) throw notFound('Atendimento não encontrado.');
	if (attendance.receptionist_id !== user.id) assertCanAccessAcademy(user, attendance.academy_id);
}

function bearerToken(authorization?: string) {
	const [scheme, token] = authorization?.split(' ') ?? [];
	return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

/**
 * O resto dos dados é opcional: o que não vier o evo-puppeteer deixa em branco
 * no formulário, para a recepção completar na mão.
 */
function missingEvoFields(row: {
	lead_name: string | null;
	evo_username: string | null;
	evo_password_encrypted: string | null;
}) {
	const required: Array<[string, unknown]> = [
		['name', row.lead_name],
		['evoCredentials', row.evo_username && row.evo_password_encrypted]
	];

	return required
		.filter(([, value]) => typeof value !== 'string' ? !value : value.trim().length === 0)
		.map(([field]) => field);
}

/**
 * O EVO tem um select de DDI ao lado do campo do telefone, que aceita só DDD +
 * número. Mandar o E.164 inteiro faria o "55" ser digitado como se fosse DDD.
 */
function telefoneComDdd(row: { whatsapp_area_code: string | null; whatsapp_number: string | null }) {
	const numero = digits(row.whatsapp_number);
	return numero ? `${digits(row.whatsapp_area_code) ?? ''}${numero}` : undefined;
}

/** Campo em branco sai do payload em vez de virar string vazia. */
function texto(value: string | null) {
	return value?.trim() || undefined;
}

function digits(value: string | null) {
	return value?.replace(/\D/g, '') || undefined;
}

function toBrazilianDate(value: string | Date) {
	const date = typeof value === 'string' ? new Date(`${value}T00:00:00`) : value;
	return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(date);
}
