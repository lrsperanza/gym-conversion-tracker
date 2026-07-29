import { Hono } from 'hono';
import { sql } from '../db/client';
import { createSession, requireAuth, revokeSession } from '../http/auth';
import { badRequest, unauthorized } from '../http/errors';
import { confirmEmailSchema, loginSchema, resetPasswordRequestSchema, resetPasswordSchema } from '../http/schemas';
import type { AppBindings, Role } from '../http/types';
import { hashPassword, verifyPassword } from '../security/crypto';
import { audit } from '../services/audit';
import { consumeEmailToken, createEmailToken } from '../services/emailTokens';
import { passwordResetEmail } from '../services/mail';

export const authRoutes = new Hono<AppBindings>();

authRoutes.post('/login', async (c) => {
	const input = loginSchema.parse(await c.req.json());
	const [user] = await sql<Array<{ id: string; password_hash: string; active: boolean }>>`
		SELECT "id", "password_hash", "active"
		FROM "gym-conversion-tracker"."users"
		WHERE "email" = ${input.email.toLowerCase()}
		LIMIT 1
	`;

	if (!user || !user.active || !(await verifyPassword(input.password, user.password_hash))) {
		throw unauthorized('Email ou senha inválidos.');
	}

	await createSession(c, user.id);
	await audit({ actorUserId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, c });
	return c.json({ ok: true });
});

authRoutes.get('/me', requireAuth, async (c) => {
	return c.json({ user: c.get('user') });
});

authRoutes.post('/logout', requireAuth, async (c) => {
	const user = c.get('user');
	await revokeSession(c);
	await audit({ actorUserId: user.id, action: 'auth.logout', entityType: 'user', entityId: user.id, c });
	return c.json({ ok: true });
});

authRoutes.post('/request-password-reset', async (c) => {
	const input = resetPasswordRequestSchema.parse(await c.req.json());
	const [user] = await sql<Array<{ id: string; name: string; email: string }>>`
		SELECT "id", "name", "email"
		FROM "gym-conversion-tracker"."users"
		WHERE "email" = ${input.email.toLowerCase()}
			AND "active" = true
		LIMIT 1
	`;

	if (user) {
		const token = await createEmailToken(user.id, 'PASSWORD_RESET', 60);
		await passwordResetEmail(user.email, user.name, token);
		await audit({ actorUserId: user.id, action: 'auth.password_reset_requested', entityType: 'user', entityId: user.id, c });
	}

	return c.json({ ok: true });
});

authRoutes.post('/reset-password', async (c) => {
	const input = resetPasswordSchema.parse(await c.req.json());
	const token = await consumeEmailToken(input.token, 'PASSWORD_RESET');
	if (!token) throw badRequest('Token inválido ou expirado.');

	const passwordHash = await hashPassword(input.password);
	await sql`
		UPDATE "gym-conversion-tracker"."users"
		SET "password_hash" = ${passwordHash}, "updated_at" = now()
		WHERE "id" = ${token.user_id}
	`;
	await sql`
		UPDATE "gym-conversion-tracker"."sessions"
		SET "revoked_at" = now()
		WHERE "user_id" = ${token.user_id}
	`;
	await audit({ actorUserId: token.user_id, action: 'auth.password_reset_completed', entityType: 'user', entityId: token.user_id, c });
	return c.json({ ok: true });
});

authRoutes.post('/confirm-email', async (c) => {
	const input = confirmEmailSchema.parse(await c.req.json());
	const token = await consumeEmailToken(input.token, 'EMAIL_CONFIRMATION');
	if (!token) throw badRequest('Token inválido ou expirado.');

	await sql`
		UPDATE "gym-conversion-tracker"."users"
		SET "email_verified_at" = now(), "updated_at" = now()
		WHERE "id" = ${token.user_id}
	`;
	await audit({ actorUserId: token.user_id, action: 'auth.email_confirmed', entityType: 'user', entityId: token.user_id, c });
	return c.json({ ok: true });
});

export async function serializeUser(userId: string) {
	const [user] = await sql<Array<{ id: string; name: string; email: string; active: boolean }>>`
		SELECT "id", "name", "email", "active"
		FROM "gym-conversion-tracker"."users"
		WHERE "id" = ${userId}
	`;
	const roles = await sql<Array<{ role: Role; academy_id: string | null }>>`
		SELECT "role", "academy_id"
		FROM "gym-conversion-tracker"."user_academy_roles"
		WHERE "user_id" = ${userId}
			AND "active" = true
	`;

	return user ? { ...user, roles: roles.map((role) => ({ role: role.role, academyId: role.academy_id })) } : null;
}

