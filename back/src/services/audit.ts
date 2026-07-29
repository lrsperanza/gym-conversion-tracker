import type { Context } from 'hono';
import { sql } from '../db/client';

type AuditInput = {
	actorUserId?: string | null;
	action: string;
	entityType: string;
	entityId?: string | null;
	payload?: unknown;
	c?: Context;
};

export async function audit(input: AuditInput) {
	const ip =
		input.c?.req.header('cf-connecting-ip') ||
		input.c?.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
		input.c?.req.header('x-real-ip') ||
		null;
	const payload = JSON.stringify(input.payload ?? {});

	await sql`
		INSERT INTO "gym-conversion-tracker"."audit_logs"
			("actor_user_id", "action", "entity_type", "entity_id", "ip", "payload")
		VALUES (${input.actorUserId ?? null}, ${input.action}, ${input.entityType}, ${input.entityId ?? null}, ${ip}, ${payload}::jsonb)
	`;
}

