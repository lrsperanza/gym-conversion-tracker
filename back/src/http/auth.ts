import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';
import { sql } from '../db/client';
import { forbidden, unauthorized } from './errors';
import type { AppBindings, Role, SessionUser } from './types';
import { createSecretToken, hashToken } from '../security/crypto';

const COOKIE_NAME = 'gct_session';
const SESSION_DAYS = 14;

function isSecureRequest(c: Context<AppBindings>) {
	const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
	return (forwardedProto ?? new URL(c.req.url).protocol.replace(':', '')) === 'https';
}

function sessionCookieOptions(c: Context<AppBindings>) {
	const secure = isSecureRequest(c);
	return {
		secure,
		sameSite: secure ? 'None' : 'Lax',
		path: '/'
	} as const;
}

export async function createSession(c: Context<AppBindings>, userId: string) {
	const token = createSecretToken();
	const tokenHash = await hashToken(token);
	const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
	const expiresAtIso = expiresAt.toISOString();
	const [session] = await sql<{ id: string }[]>`
		INSERT INTO "gym-conversion-tracker"."sessions" ("user_id", "token_hash", "expires_at")
		VALUES (${userId}, ${tokenHash}, ${expiresAtIso}::timestamptz)
		RETURNING "id"
	`;
	if (!session) throw new Error('Falha ao criar sessão.');

	setCookie(c, COOKIE_NAME, token, {
		...sessionCookieOptions(c),
		httpOnly: true,
		expires: expiresAt
	});

	return session.id;
}

export async function revokeSession(c: Context<AppBindings>) {
	const sessionId = c.get('sessionId');
	if (sessionId) {
		await sql`
			UPDATE "gym-conversion-tracker"."sessions"
			SET "revoked_at" = now()
			WHERE "id" = ${sessionId}
		`;
	}
	deleteCookie(c, COOKIE_NAME, sessionCookieOptions(c));
}

export const requireAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
	const token = getCookie(c, COOKIE_NAME);
	if (!token) throw unauthorized();

	const tokenHash = await hashToken(token);
	const [session] = await sql<
		Array<{
			session_id: string;
			user_id: string;
			name: string;
			email: string;
			active: boolean;
		}>
	>`
		SELECT s."id" AS session_id, u."id" AS user_id, u."name", u."email", u."active"
		FROM "gym-conversion-tracker"."sessions" s
		JOIN "gym-conversion-tracker"."users" u ON u."id" = s."user_id"
		WHERE s."token_hash" = ${tokenHash}
			AND s."revoked_at" IS NULL
			AND s."expires_at" > now()
		LIMIT 1
	`;

	if (!session || !session.active) throw unauthorized();

	const roles = await sql<Array<{ role: Role; academy_id: string | null }>>`
		SELECT "role", "academy_id"
		FROM "gym-conversion-tracker"."user_academy_roles"
		WHERE "user_id" = ${session.user_id}
			AND "active" = true
	`;

	c.set('sessionId', session.session_id);
	c.set('user', {
		id: session.user_id,
		name: session.name,
		email: session.email,
		active: session.active,
		roles: roles.map((role) => ({ role: role.role, academyId: role.academy_id }))
	});

	await next();
};

export function requireAnyRole(...roles: Role[]): MiddlewareHandler<AppBindings> {
	return async (c, next) => {
		const user = c.get('user');
		if (!hasAnyRole(user, roles)) throw forbidden();
		await next();
	};
}

export function hasAnyRole(user: SessionUser, roles: Role[]) {
	return user.roles.some((assignment) => roles.includes(assignment.role));
}

export function hasGlobalRole(user: SessionUser, roles: Role[]) {
	return user.roles.some((assignment) => assignment.academyId === null && roles.includes(assignment.role));
}

export function canAccessAcademy(user: SessionUser, academyId: string) {
	if (hasAnyRole(user, ['ADMIN', 'SOCIO'])) return true;
	return user.roles.some((assignment) => assignment.academyId === academyId);
}

export function assertCanAccessAcademy(user: SessionUser, academyId: string) {
	if (!canAccessAcademy(user, academyId)) throw forbidden('Você não tem acesso a esta academia.');
}

export function canManageUserRole(actor: SessionUser, role: Role, academyIds: string[]) {
	if (role === 'ADMIN') return hasAnyRole(actor, ['ADMIN']);
	if (hasAnyRole(actor, ['ADMIN', 'SOCIO'])) return true;
	if (!['GERENTE_REGIONAL', 'LIDER'].some((allowedRole) => hasAnyRole(actor, [allowedRole as Role]))) return false;
	if (role !== 'RECEPCIONISTA') return false;
	return academyIds.every((academyId) => canAccessAcademy(actor, academyId));
}

export function canManageProfessor(actor: SessionUser, academyId: string, action: 'create' | 'update' | 'deactivate') {
	if (!canAccessAcademy(actor, academyId)) return false;
	if (action === 'create') return hasAnyRole(actor, ['ADMIN', 'SOCIO', 'GERENTE_REGIONAL', 'LIDER', 'RECEPCIONISTA']);
	return hasAnyRole(actor, ['ADMIN', 'SOCIO', 'GERENTE_REGIONAL', 'LIDER']);
}

