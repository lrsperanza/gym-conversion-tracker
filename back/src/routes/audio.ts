import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { z } from 'zod';
import { env } from '../config/env';
import { sql } from '../db/client';
import { assertCanAccessAcademy, canListenAudio, requireAuth } from '../http/auth';
import { AppError, badRequest, conflict, forbidden, notFound } from '../http/errors';
import type { AppBindings } from '../http/types';
import { audit } from '../services/audit';
import { azureStorageConfigured, blobDownloadUrl, ensureContainer, uploadBlob } from '../services/azureBlob';
import { computeAudioParts, NoReadableAudioError, renderAudioPart, type AudioPart, type AudioWindow } from '../services/audio/clip';

export const audioRoutes = new Hono<AppBindings>();

audioRoutes.use('*', requireAuth);

const uploadMetaSchema = z.object({
	part: z.enum(['FULL', 'HEAD', 'TAIL']),
	deviceId: z.string().uuid(),
	deviceLabel: z.string().trim().max(120).optional(),
	chunks: z
		.array(
			z.object({
				startedAt: z.string().min(1),
				endedAt: z.string().min(1),
				mime: z.string().optional()
			})
		)
		.min(1)
});

type AttendanceAudioRow = {
	id: string;
	academy_id: string;
	receptionist_id: string;
	started_at: string | Date;
	closed_at: string | Date | null;
	close_event_id: string | null;
	started_by_user_id: string;
	closed_by_user_id: string | null;
	lead_id: string;
	lead_name: string;
	lead_surname: string | null;
	receptionist_name: string;
	professor_id: string | null;
	professor_name: string | null;
};

type ActivePartRow = {
	attendance_id: string;
	part: AudioPart;
	status: 'UPLOADED' | 'MISSING';
};

function asDate(value: string | Date): Date {
	return value instanceof Date ? value : new Date(value);
}

function participants(row: AttendanceAudioRow) {
	const leadName = [row.lead_name, row.lead_surname].filter(Boolean).join(' ');
	return [
		{ role: 'lead', id: row.lead_id, name: leadName },
		{ role: 'receptionist', id: row.receptionist_id, name: row.receptionist_name },
		{ role: 'professor', id: row.professor_id, name: row.professor_name }
	].filter((participant) => participant.name);
}

function cutoffWithGrace(now: Date) {
	const graceSeconds = Math.max(env.audio.chunkSeconds * 2, 120);
	return new Date(now.getTime() - (env.audio.bufferMinutes * 60 + graceSeconds) * 1000);
}

function windowTooOld(window: AudioWindow, now: Date) {
	return window.windowEnd.getTime() < cutoffWithGrace(now).getTime();
}

function publicWindow(row: AttendanceAudioRow, window: AudioWindow, now: Date) {
	return {
		attendanceId: row.id,
		academyId: row.academy_id,
		part: window.part,
		windowStart: window.windowStart.toISOString(),
		windowEnd: window.windowEnd.toISOString(),
		closeEventId: window.part === 'HEAD' ? null : row.close_event_id,
		bufferTooOld: windowTooOld(window, now)
	};
}

const attendanceAudioSelect = () => sql`
	SELECT
		a."id",
		a."academy_id",
		a."receptionist_id",
		a."started_at",
		a."closed_at",
		close_event."id" AS "close_event_id",
		COALESCE(open_event."actor_user_id", a."receptionist_id") AS "started_by_user_id",
		close_event."actor_user_id" AS "closed_by_user_id",
		l."id" AS "lead_id",
		l."name" AS "lead_name",
		l."surname" AS "lead_surname",
		r."name" AS "receptionist_name",
		p."id" AS "professor_id",
		p."name" AS "professor_name"
	FROM "gym-conversion-tracker"."attendances" a
	JOIN "gym-conversion-tracker"."leads" l ON l."id" = a."lead_id"
	JOIN "gym-conversion-tracker"."users" r ON r."id" = a."receptionist_id"
	LEFT JOIN "gym-conversion-tracker"."professors" p ON p."id" = a."professor_id"
	LEFT JOIN LATERAL (
		SELECT e."actor_user_id"
		FROM "gym-conversion-tracker"."attendance_events" e
		WHERE e."attendance_id" = a."id" AND e."type" IN ('TOUR_RECEPTIONIST', 'TOUR_PROFESSOR')
		ORDER BY e."created_at"
		LIMIT 1
	) open_event ON true
	LEFT JOIN LATERAL (
		SELECT e."id", e."actor_user_id"
		FROM "gym-conversion-tracker"."attendance_events" e
		WHERE e."attendance_id" = a."id" AND e."type" = 'CLOSE'
		ORDER BY e."created_at" DESC
		LIMIT 1
	) close_event ON true
`;

// HEAD is heard by whoever opened the attendance, TAIL by whoever closed it;
// FULL spans both, so either may send it and the first upload wins.
function canUploadPart(row: AttendanceAudioRow, part: AudioPart, userId: string) {
	const opened = row.started_by_user_id === userId;
	const closed = row.closed_by_user_id === userId;
	if (part === 'HEAD') return opened;
	if (part === 'TAIL') return closed;
	return opened || closed;
}

async function listCandidateAttendances(userId: string) {
	return await sql<AttendanceAudioRow[]>`
		${attendanceAudioSelect()}
		WHERE (COALESCE(open_event."actor_user_id", a."receptionist_id") = ${userId} OR close_event."actor_user_id" = ${userId})
			AND a."status" <> 'DRAFT'
			AND (a."status" <> 'FINALIZED' OR a."started_at" > now() - (10080 * interval '1 minute'))
		ORDER BY a."started_at" DESC
		LIMIT 200
	`;
}

async function activePartsFor(attendanceIds: string[]) {
	if (attendanceIds.length === 0) return new Set<string>();
	const rows = await sql<ActivePartRow[]>`
		SELECT "attendance_id", "part", "status"
		FROM "gym-conversion-tracker"."attendance_audio_parts"
		WHERE "superseded_at" IS NULL
			AND "attendance_id" IN ${sql(attendanceIds)}
	`;
	return new Set(rows.map((row) => `${row.attendance_id}:${row.part}`));
}

async function markMissing(row: AttendanceAudioRow, window: AudioWindow, userId: string, deviceId: string | null) {
	const payload = JSON.stringify(participants(row));
	const gaps = JSON.stringify([
		{
			start: window.windowStart.toISOString(),
			end: window.windowEnd.toISOString(),
			seconds: Math.round((window.windowEnd.getTime() - window.windowStart.getTime()) / 1000)
		}
	]);
	await sql`
		INSERT INTO "gym-conversion-tracker"."attendance_audio_parts"
			("attendance_id", "academy_id", "part", "status", "close_event_id", "window_start", "window_end", "recorded_by_user_id", "device_id", "covered_seconds", "gaps", "participants")
		SELECT ${row.id}, ${row.academy_id}, ${window.part}::"gym-conversion-tracker"."audio_part", 'MISSING', ${window.part === 'HEAD' ? null : row.close_event_id}, ${window.windowStart.toISOString()}::timestamptz, ${window.windowEnd.toISOString()}::timestamptz, ${userId}, ${deviceId}, 0, ${gaps}::jsonb, ${payload}::jsonb
		WHERE NOT EXISTS (
			SELECT 1
			FROM "gym-conversion-tracker"."attendance_audio_parts"
			WHERE "attendance_id" = ${row.id}
				AND "part" = ${window.part}::"gym-conversion-tracker"."audio_part"
				AND "superseded_at" IS NULL
		)
	`;
}

audioRoutes.get('/audio/config', (c) =>
	c.json({
		enabled: env.audio.enabled,
		bufferMinutes: env.audio.bufferMinutes,
		clipMinutes: env.audio.clipMinutes,
		chunkSeconds: env.audio.chunkSeconds,
		serverTime: new Date().toISOString()
	})
);

audioRoutes.get('/audio/pending', async (c) => {
	const user = c.get('user');
	const deviceId = c.req.query('deviceId') ?? null;
	if (!env.audio.enabled) return c.json({ parts: [], serverTime: new Date().toISOString() });

	const now = new Date();
	const rows = await listCandidateAttendances(user.id);
	const active = await activePartsFor(rows.map((row) => row.id));
	const parts = [];

	for (const row of rows) {
		const windows = computeAudioParts(asDate(row.started_at), row.closed_at ? asDate(row.closed_at) : null, now, env.audio.clipMinutes);
		for (const window of windows) {
			if (!canUploadPart(row, window.part, user.id)) continue;
			if (active.has(`${row.id}:${window.part}`)) continue;
			if (windowTooOld(window, now)) {
				await markMissing(row, window, user.id, deviceId);
				active.add(`${row.id}:${window.part}`);
				continue;
			}
			parts.push(publicWindow(row, window, now));
		}
	}

	return c.json({ parts, serverTime: now.toISOString() });
});

async function loadAttendanceForUpload(attendanceId: string) {
	const [row] = await sql<AttendanceAudioRow[]>`
		${attendanceAudioSelect()}
		WHERE a."id" = ${attendanceId}
	`;
	return row;
}

function matchingWindow(row: AttendanceAudioRow, part: AudioPart, now: Date) {
	return computeAudioParts(asDate(row.started_at), row.closed_at ? asDate(row.closed_at) : null, now, env.audio.clipMinutes).find(
		(window) => window.part === part
	);
}

function asSingleString(value: FormDataEntryValue | FormDataEntryValue[] | undefined, field: string) {
	const item = Array.isArray(value) ? value[0] : value;
	if (typeof item !== 'string') throw badRequest(`Campo multipart "${field}" ausente.`);
	return item;
}

function asFiles(value: FormDataEntryValue | FormDataEntryValue[] | undefined) {
	const values = Array.isArray(value) ? value : value ? [value] : [];
	return values.filter((item): item is File => item instanceof File);
}

async function sha256File(path: string) {
	const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

audioRoutes.post('/attendances/:id/audio', async (c) => {
	if (!env.audio.enabled) throw badRequest('Gravacao de audio desativada.');
	if (!azureStorageConfigured()) throw new AppError(503, 'Azure Storage nao esta configurado para receber audios.', 'AZURE_UNAVAILABLE');

	const user = c.get('user');
	const attendanceId = c.req.param('id');
	const body = await c.req.parseBody({ all: true });
	const meta = uploadMetaSchema.parse(JSON.parse(asSingleString(body.meta, 'meta')));
	const files = asFiles(body.chunks ?? body.chunk);
	if (files.length !== meta.chunks.length) {
		throw badRequest('Quantidade de arquivos de audio nao corresponde aos metadados.');
	}

	const row = await loadAttendanceForUpload(attendanceId);
	if (!row) throw notFound();
	if (!canUploadPart(row, meta.part, user.id)) {
		throw forbidden('Só quem abriu ou fechou o atendimento pode enviar este trecho de audio.');
	}
	const now = new Date();
	const window = matchingWindow(row, meta.part, now);
	if (!window) throw badRequest('Janela de audio ainda nao esta disponivel para este atendimento.');
	if (windowTooOld(window, now)) throw badRequest('Janela de audio expirou no buffer local.');

	const [existing] = await sql<Array<{ id: string; status: string }>>`
		SELECT "id", "status"
		FROM "gym-conversion-tracker"."attendance_audio_parts"
		WHERE "attendance_id" = ${attendanceId}
			AND "part" = ${meta.part}::"gym-conversion-tracker"."audio_part"
			AND "superseded_at" IS NULL
		LIMIT 1
	`;
	if (existing) throw conflict(existing.status === 'MISSING' ? 'Audio registrado como indisponivel.' : 'Audio ja enviado para esta janela.');

	const tempDir = await mkdtemp(join(tmpdir(), 'gct-audio-'));
	try {
		const chunks = [];
		for (let index = 0; index < files.length; index += 1) {
			const file = files[index]!;
			const chunkMeta = meta.chunks[index]!;
			const startedAt = new Date(chunkMeta.startedAt);
			const endedAt = new Date(chunkMeta.endedAt);
			if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
				throw badRequest('Metadados de chunk de audio invalidos.');
			}
			// A recorder stopped in the same instant it started leaves a zero-length chunk;
			// it carries no audio, so skip it instead of failing the whole upload.
			if (endedAt <= startedAt || file.size === 0) continue;
			const path = join(tempDir, `${index}.webm`);
			await writeFile(path, new Uint8Array(await file.arrayBuffer()));
			chunks.push({ path, startedAt, endedAt });
		}
		if (chunks.length === 0) throw new AppError(422, 'Nenhum trecho de audio legivel cobre a janela solicitada.', 'AUDIO_UNREADABLE');

		const partId = crypto.randomUUID();
		const outputPath = join(tempDir, `${partId}.webm`);
		const coverage = await renderAudioPart({
			windowStart: window.windowStart,
			windowEnd: window.windowEnd,
			chunks,
			outputPath
		}).catch((error: unknown) => {
			if (error instanceof NoReadableAudioError) throw new AppError(422, error.message, 'AUDIO_UNREADABLE');
			throw error;
		});
		const output = Bun.file(outputPath);
		if (!(await output.exists()) || output.size === 0) throw badRequest('Audio gerado ficou vazio.');
		const bytes = new Uint8Array(await output.arrayBuffer());
		const hash = await sha256File(outputPath);
		const blobName = `${row.academy_id}/${attendanceId}/${meta.part.toLowerCase()}-${partId}.webm`;
		const payload = JSON.stringify(participants(row));
		const gaps = JSON.stringify(coverage.gaps);

		await ensureContainer(env.audio.container);
		await uploadBlob(env.audio.container, blobName, bytes, {
			contentType: 'audio/webm;codecs=opus',
			metadata: {
				attendanceid: attendanceId,
				academyid: row.academy_id,
				part: meta.part.toLowerCase(),
				deviceid: meta.deviceId,
				recordedby: user.id
			}
		});

		const [created] = await sql<Array<{ id: string }>>`
			INSERT INTO "gym-conversion-tracker"."attendance_audio_parts"
				("id", "attendance_id", "academy_id", "part", "status", "close_event_id", "window_start", "window_end", "recorded_by_user_id", "device_id", "device_label", "covered_seconds", "gaps", "blob_name", "mime", "size_bytes", "sha256", "participants")
			VALUES (${partId}, ${attendanceId}, ${row.academy_id}, ${meta.part}::"gym-conversion-tracker"."audio_part", 'UPLOADED', ${meta.part === 'HEAD' ? null : row.close_event_id}, ${window.windowStart.toISOString()}::timestamptz, ${window.windowEnd.toISOString()}::timestamptz, ${user.id}, ${meta.deviceId}, ${meta.deviceLabel ?? null}, ${coverage.coveredSeconds}, ${gaps}::jsonb, ${blobName}, ${'audio/webm;codecs=opus'}, ${output.size}, ${hash}, ${payload}::jsonb)
			RETURNING "id"
		`.catch((error: unknown) => {
			if ((error as { code?: string })?.code === '23505') throw conflict('Audio ja enviado para esta janela.');
			throw error;
		});
		if (!created) throw new Error('Falha ao registrar audio do atendimento.');

		await audit({
			actorUserId: user.id,
			action: 'attendance.audio.upload',
			entityType: 'attendance',
			entityId: attendanceId,
			payload: {
				part: meta.part,
				audioPartId: partId,
				deviceId: meta.deviceId,
				coveredSeconds: coverage.coveredSeconds,
				discardedChunks: coverage.discardedChunks
			},
			c
		});

		return c.json({ partId, blobName, coveredSeconds: coverage.coveredSeconds, gaps: coverage.gaps }, 201);
	} finally {
		await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	}
});

audioRoutes.get('/attendances/:id/audio', async (c) => {
	const user = c.get('user');
	const attendanceId = c.req.param('id');
	const [attendance] = await sql<Array<{ academy_id: string }>>`
		SELECT "academy_id"
		FROM "gym-conversion-tracker"."attendances"
		WHERE "id" = ${attendanceId}
	`;
	if (!attendance) throw notFound();
	if (!canListenAudio(user, attendance.academy_id)) throw forbidden('Você não tem permissão para ouvir audios de atendimento.');
	assertCanAccessAcademy(user, attendance.academy_id);

	const rows = await sql<
		Array<{
			id: string;
			attendance_id: string;
			part: AudioPart;
			status: 'UPLOADED' | 'MISSING';
			window_start: string | Date;
			window_end: string | Date;
			recorded_by_user_id: string | null;
			recorded_by_user_name: string | null;
			device_id: string | null;
			device_label: string | null;
			covered_seconds: number;
			gaps: unknown;
			blob_name: string | null;
			mime: string | null;
			size_bytes: number | null;
			sha256: string | null;
			participants: unknown;
			transcription_status: string;
			created_at: string | Date;
		}>
	>`
		SELECT
			p."id",
			p."attendance_id",
			p."part",
			p."status",
			p."window_start",
			p."window_end",
			p."recorded_by_user_id",
			u."name" AS "recorded_by_user_name",
			p."device_id",
			p."device_label",
			p."covered_seconds",
			p."gaps",
			p."blob_name",
			p."mime",
			p."size_bytes",
			p."sha256",
			p."participants",
			p."transcription_status",
			p."created_at"
		FROM "gym-conversion-tracker"."attendance_audio_parts" p
		LEFT JOIN "gym-conversion-tracker"."users" u ON u."id" = p."recorded_by_user_id"
		WHERE p."attendance_id" = ${attendanceId}
			AND p."superseded_at" IS NULL
		ORDER BY p."window_start", p."part"
	`;

	const parts = await Promise.all(
		rows.map(async (row) => ({
			id: row.id,
			attendanceId: row.attendance_id,
			part: row.part,
			status: row.status,
			windowStart: asDate(row.window_start).toISOString(),
			windowEnd: asDate(row.window_end).toISOString(),
			recordedByUserId: row.recorded_by_user_id,
			recordedByUserName: row.recorded_by_user_name,
			deviceId: row.device_id,
			deviceLabel: row.device_label,
			coveredSeconds: row.covered_seconds,
			gaps: row.gaps ?? [],
			blobName: row.blob_name,
			mime: row.mime,
			sizeBytes: row.size_bytes,
			sha256: row.sha256,
			participants: row.participants ?? [],
			transcriptionStatus: row.transcription_status,
			downloadUrl:
				row.status === 'UPLOADED' && row.blob_name && azureStorageConfigured()
					? await blobDownloadUrl(env.audio.container, row.blob_name, 15 * 60)
					: null,
			createdAt: asDate(row.created_at).toISOString()
		}))
	);

	const events = await sql<Array<{ id: string; type: string; description: string | null; created_at: string | Date; actor_name: string }>>`
		SELECT e."id", e."type", e."description", e."created_at", u."name" AS "actor_name"
		FROM "gym-conversion-tracker"."attendance_events" e
		JOIN "gym-conversion-tracker"."users" u ON u."id" = e."actor_user_id"
		WHERE e."attendance_id" = ${attendanceId}
		ORDER BY e."created_at"
	`;

	await audit({
		actorUserId: user.id,
		action: 'attendance.audio.play',
		entityType: 'attendance',
		entityId: attendanceId,
		payload: { parts: rows.map((row) => row.id) },
		c
	});

	return c.json({
		parts,
		events: events.map((event) => ({
			id: event.id,
			type: event.type,
			description: event.description,
			createdAt: asDate(event.created_at).toISOString(),
			actorName: event.actor_name
		}))
	});
});
