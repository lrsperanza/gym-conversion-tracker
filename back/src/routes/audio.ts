import { Hono } from 'hono';
import { z } from 'zod';
import { env } from '../config/env';
import { sql } from '../db/client';
import { assertCanAccessAcademy, canAccessAcademy, hasAnyRole, requireAnyRole, requireAuth } from '../http/auth';
import { badRequest, forbidden, notFound } from '../http/errors';
import type { AppBindings, SessionUser } from '../http/types';
import { gcpAccessToken } from '../services/gcpToken';
import { downloadBlob, uploadBlob } from '../services/gcsStorage';

/**
 * Gravação contínua do microfone da recepção.
 *
 * O front grava trechos autocontidos de ~AUDIO_SEGMENT_SECONDS e sobe cada um aqui; o back guarda o
 * arquivo no bucket privado e indexa o trecho por horário no DSQL. A auditoria (dashboard) lista os
 * trechos de um período e baixa cada arquivo por este mesmo serviço, porque o bucket não é público.
 * O bucket apaga os objetos após AUDIO_RETENTION_DAYS (lifecycle); as linhas são podadas aqui.
 */
export const audioRoutes = new Hono<AppBindings>();

audioRoutes.use('*', requireAuth);

const MAX_SEGMENT_BYTES = 8 * 1024 * 1024;
const MAX_TIMELINE_HOURS = 48;
const MAX_TIMELINE_SEGMENTS = 6_000;
const PURGE_INTERVAL_MS = 60 * 60_000;
const PURGE_BATCH = 1_000;
const MIME_EXTENSIONS: Record<string, string> = {
	'audio/webm': 'webm',
	'audio/ogg': 'ogg',
	'audio/mp4': 'm4a'
};

const reviewRoles = requireAnyRole('ADMIN', 'SOCIO', 'GERENTE_REGIONAL');

const segmentMetaSchema = z.object({
	deviceId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/, 'deviceId inválido.'),
	deviceLabel: z.string().trim().max(200).optional(),
	academyId: z.string().uuid().optional(),
	startedAt: z.string().datetime({ offset: true }),
	endedAt: z.string().datetime({ offset: true })
});

const timelineQuerySchema = z.object({
	academyId: z.string().uuid(),
	from: z.string().datetime({ offset: true }),
	to: z.string().datetime({ offset: true })
});

audioRoutes.get('/audio/config', (c) =>
	c.json({
		enabled: env.audio.enabled && Boolean(env.audio.bucket),
		segmentSeconds: env.audio.segmentSeconds,
		retentionDays: env.audio.retentionDays,
		serverTime: new Date().toISOString()
	})
);

audioRoutes.post('/audio/segments', async (c) => {
	if (!env.audio.enabled || !env.audio.bucket) throw badRequest('Gravação de áudio desativada.');
	const user = c.get('user');
	const body = await c.req.parseBody();
	const file = body.file;
	if (!(file instanceof File) || file.size === 0) throw badRequest('Envie o arquivo de áudio em "file".');
	if (file.size > MAX_SEGMENT_BYTES) throw badRequest('Trecho de áudio grande demais.');

	const meta = segmentMetaSchema.parse({
		deviceId: body.deviceId,
		deviceLabel: typeof body.deviceLabel === 'string' && body.deviceLabel ? body.deviceLabel : undefined,
		academyId: typeof body.academyId === 'string' && body.academyId ? body.academyId : undefined,
		startedAt: body.startedAt,
		endedAt: body.endedAt
	});

	const startedAt = new Date(meta.startedAt);
	const endedAt = new Date(meta.endedAt);
	const durationMs = endedAt.getTime() - startedAt.getTime();
	if (durationMs <= 0) throw badRequest('O fim do trecho precisa ser depois do início.');
	if (durationMs > env.audio.segmentSeconds * 5 * 1_000) throw badRequest('Trecho de áudio longo demais.');
	if (endedAt.getTime() > Date.now() + 5 * 60_000) throw badRequest('Horário do trecho está no futuro.');
	if (startedAt.getTime() < Date.now() - env.audio.retentionDays * 86_400_000) {
		// Já teria sido apagado pela retenção; o cliente pode descartar.
		return c.json({ ok: true, skipped: 'expired' });
	}

	const academyId = resolveRecordingAcademy(user, meta.academyId);
	// O Bun redefine o tipo da parte pela extensão do nome (segment.webm vira video/webm), então o
	// container vale mais que o prefixo: só existe áudio aqui.
	const mime = (file.type || 'audio/webm').split(';')[0]!.trim().toLowerCase().replace(/^video\//, 'audio/');
	const extension = MIME_EXTENSIONS[mime];
	if (!extension) throw badRequest(`Formato de áudio não suportado: ${mime}.`);

	// Nome determinístico: o reenvio do mesmo trecho sobrescreve o mesmo objeto.
	const objectName = [
		academyId ?? 'sem-academia',
		localDay(startedAt),
		meta.deviceId,
		`${startedAt.toISOString().replace(/[:.]/g, '-')}.${extension}`
	].join('/');

	await uploadBlob(env.audio.bucket, objectName, new Uint8Array(await file.arrayBuffer()), {
		accessToken: await gcpAccessToken(),
		contentType: mime,
		cacheControl: 'private, max-age=86400',
		metadata: { userId: user.id, deviceId: meta.deviceId }
	});

	await sql`
		INSERT INTO "gym-conversion-tracker"."audio_segments"
			("academy_id", "user_id", "device_id", "device_label", "started_at", "ended_at", "duration_ms", "object_name", "mime", "size_bytes")
		VALUES (
			${academyId}, ${user.id}, ${meta.deviceId}, ${meta.deviceLabel ?? null},
			${startedAt.toISOString()}::timestamptz, ${endedAt.toISOString()}::timestamptz,
			${durationMs}, ${objectName}, ${mime}, ${file.size}
		)
		ON CONFLICT ("device_id", "started_at") DO NOTHING
	`;

	schedulePurge();
	return c.json({ ok: true, objectName, serverTime: new Date().toISOString() });
});

audioRoutes.get('/audio/timeline', reviewRoles, async (c) => {
	const user = c.get('user');
	const query = timelineQuerySchema.parse({
		academyId: c.req.query('academyId'),
		from: c.req.query('from'),
		to: c.req.query('to')
	});
	assertCanAccessAcademy(user, query.academyId);

	const from = new Date(query.from);
	const to = new Date(query.to);
	if (to <= from) throw badRequest('Período inválido.');
	if (to.getTime() - from.getTime() > MAX_TIMELINE_HOURS * 3_600_000) {
		throw badRequest(`Período máximo de ${MAX_TIMELINE_HOURS} horas.`);
	}
	const retentionStart = new Date(Date.now() - env.audio.retentionDays * 86_400_000);
	const fromIso = (from > retentionStart ? from : retentionStart).toISOString();
	const toIso = to.toISOString();

	const [segments, attendances] = await Promise.all([
		sql<
			Array<{
				id: string;
				userId: string;
				userName: string | null;
				deviceId: string;
				deviceLabel: string | null;
				startedAt: string;
				endedAt: string;
				durationMs: number;
				sizeBytes: number;
				mime: string;
			}>
		>`
			SELECT
				s."id",
				s."user_id" AS "userId",
				u."name" AS "userName",
				s."device_id" AS "deviceId",
				s."device_label" AS "deviceLabel",
				s."started_at" AS "startedAt",
				s."ended_at" AS "endedAt",
				s."duration_ms" AS "durationMs",
				s."size_bytes" AS "sizeBytes",
				s."mime"
			FROM "gym-conversion-tracker"."audio_segments" s
			LEFT JOIN "gym-conversion-tracker"."users" u ON u."id" = s."user_id"
			WHERE s."academy_id" = ${query.academyId}
				AND s."started_at" < ${toIso}::timestamptz
				AND s."ended_at" > ${fromIso}::timestamptz
			ORDER BY s."started_at"
			LIMIT ${MAX_TIMELINE_SEGMENTS}
		`,
		sql<
			Array<{
				id: string;
				startedAt: string;
				closedAt: string | null;
				status: string;
				leadName: string;
				receptionistId: string;
				receptionistName: string;
			}>
		>`
			SELECT
				a."id",
				a."started_at" AS "startedAt",
				a."closed_at" AS "closedAt",
				a."status",
				l."name" AS "leadName",
				a."receptionist_id" AS "receptionistId",
				u."name" AS "receptionistName"
			FROM "gym-conversion-tracker"."attendances" a
			JOIN "gym-conversion-tracker"."leads" l ON l."id" = a."lead_id"
			JOIN "gym-conversion-tracker"."users" u ON u."id" = a."receptionist_id"
			WHERE a."academy_id" = ${query.academyId}
				AND a."started_at" >= ${query.from}::timestamptz
				AND a."started_at" < ${toIso}::timestamptz
			ORDER BY a."started_at"
			LIMIT 500
		`
	]);

	return c.json({
		segments,
		attendances,
		truncated: segments.length >= MAX_TIMELINE_SEGMENTS,
		retentionDays: env.audio.retentionDays
	});
});

audioRoutes.get('/audio/segments/:id/file', reviewRoles, async (c) => {
	const user = c.get('user');
	const id = z.string().uuid().parse(c.req.param('id'));
	const [segment] = await sql<Array<{ academy_id: string | null; object_name: string; mime: string }>>`
		SELECT "academy_id", "object_name", "mime"
		FROM "gym-conversion-tracker"."audio_segments"
		WHERE "id" = ${id}
	`;
	if (!segment) throw notFound('Trecho de áudio não encontrado.');
	if (segment.academy_id ? !canAccessAcademy(user, segment.academy_id) : !hasAnyRole(user, ['ADMIN', 'SOCIO'])) {
		throw forbidden('Você não tem acesso a este áudio.');
	}

	let upstream: Response;
	try {
		upstream = await downloadBlob(env.audio.bucket, segment.object_name, await gcpAccessToken());
	} catch (error) {
		// 404 do GCS: o lifecycle já apagou o objeto antes da poda da linha.
		if (error instanceof Error && error.message.includes('HTTP 404')) throw notFound('Áudio expirado.');
		throw error;
	}

	const headers = new Headers({
		'Content-Type': segment.mime,
		'Cache-Control': 'private, max-age=86400, immutable'
	});
	const length = upstream.headers.get('content-length');
	if (length) headers.set('Content-Length', length);
	return new Response(upstream.body, { status: 200, headers });
});

/**
 * Academia do trecho: a que o front informou (a selecionada na recepção), se o usuário tiver acesso;
 * senão a primeira academia em que ele tem papel. Usuário só com papel global fica sem academia.
 */
function resolveRecordingAcademy(user: SessionUser, requested: string | undefined) {
	if (requested && canAccessAcademy(user, requested)) return requested;
	return user.roles.find((role) => role.academyId)?.academyId ?? null;
}

function localDay(date: Date) {
	return new Intl.DateTimeFormat('en-CA', { timeZone: env.video.timeZone }).format(date);
}

let lastPurgeAt = 0;
let purging = false;

/** Poda as linhas além da retenção, no máximo uma vez por hora por instância e fora da requisição. */
function schedulePurge() {
	if (purging || Date.now() - lastPurgeAt < PURGE_INTERVAL_MS) return;
	purging = true;
	lastPurgeAt = Date.now();
	void purgeExpiredSegments()
		.catch((error) => console.error('Falha ao podar audio_segments:', error))
		.finally(() => {
			purging = false;
		});
}

async function purgeExpiredSegments() {
	const cutoff = new Date(Date.now() - env.audio.retentionDays * 86_400_000).toISOString();
	// O DSQL limita 3.000 linhas por transação, então apaga em lotes.
	for (;;) {
		const deleted = await sql`
			DELETE FROM "gym-conversion-tracker"."audio_segments"
			WHERE "id" IN (
				SELECT "id"
				FROM "gym-conversion-tracker"."audio_segments"
				WHERE "started_at" < ${cutoff}::timestamptz
				LIMIT ${PURGE_BATCH}
			)
		`;
		if (deleted.count < PURGE_BATCH) return;
	}
}
