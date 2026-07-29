import { sql } from '../db/client';
import { createSecretToken, hashToken } from '../security/crypto';

export async function createEmailToken(
	userId: string,
	purpose: 'EMAIL_CONFIRMATION' | 'PASSWORD_RESET',
	minutes: number
) {
	const token = createSecretToken();
	const tokenHash = await hashToken(token);
	const expiresAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();

	await sql`
		INSERT INTO "gym-conversion-tracker"."email_tokens"
			("user_id", "token_hash", "purpose", "expires_at")
		VALUES (${userId}, ${tokenHash}, ${purpose}, ${expiresAt}::timestamptz)
	`;

	return token;
}

export async function consumeEmailToken(token: string, purpose: 'EMAIL_CONFIRMATION' | 'PASSWORD_RESET') {
	const tokenHash = await hashToken(token);
	const [row] = await sql<Array<{ id: string; user_id: string }>>`
		UPDATE "gym-conversion-tracker"."email_tokens"
		SET "consumed_at" = now()
		WHERE "token_hash" = ${tokenHash}
			AND "purpose" = ${purpose}
			AND "consumed_at" IS NULL
			AND "expires_at" > now()
		RETURNING "id", "user_id"
	`;

	return row ?? null;
}

