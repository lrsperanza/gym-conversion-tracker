import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';

const TICKET_TTL_SECONDS = 5 * 60;

export type EvoTicketPayload = {
	attendanceId: string;
	userId: string;
	exp: number;
	nonce: string;
};

export function createEvoTicket(attendanceId: string, userId: string) {
	const payload: EvoTicketPayload = {
		attendanceId,
		userId,
		exp: Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS,
		nonce: randomBytes(16).toString('base64url')
	};
	const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const signature = sign(encodedPayload);

	return {
		ticket: `${encodedPayload}.${signature}`,
		expiresAt: new Date(payload.exp * 1000).toISOString()
	};
}

export function verifyEvoTicket(ticket: string, attendanceId: string): EvoTicketPayload | null {
	const [encodedPayload, signature] = ticket.split('.');
	if (!encodedPayload || !signature) return null;

	const expected = sign(encodedPayload);
	if (!safeEqual(signature, expected)) return null;

	const payload = parsePayload(encodedPayload);
	if (!payload) return null;
	if (payload.attendanceId !== attendanceId) return null;
	if (payload.exp <= Math.floor(Date.now() / 1000)) return null;

	return payload;
}

function parsePayload(encodedPayload: string): EvoTicketPayload | null {
	try {
		const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Partial<EvoTicketPayload>;
		if (
			typeof payload.attendanceId !== 'string' ||
			typeof payload.userId !== 'string' ||
			typeof payload.exp !== 'number' ||
			typeof payload.nonce !== 'string'
		) {
			return null;
		}
		return payload as EvoTicketPayload;
	} catch {
		return null;
	}
}

function sign(value: string) {
	return createHmac('sha256', ticketKey()).update(value).digest('base64url');
}

function ticketKey(): Buffer {
	if (!env.evo.ticketKey) {
		throw new Error('EVO_TICKET_KEY ou EVO_CRED_KEY ausente. Gere uma chave para assinar tickets do EVO.');
	}

	const parsed = Buffer.from(env.evo.ticketKey, 'base64');
	return parsed.length >= 32 ? parsed : Buffer.from(env.evo.ticketKey, 'utf8');
}

function safeEqual(a: string, b: string) {
	const aBuffer = Buffer.from(a);
	const bBuffer = Buffer.from(b);
	return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}
