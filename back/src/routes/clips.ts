import { Hono } from 'hono';
import { z } from 'zod';
import { env } from '../config/env';
import { sql } from '../db/client';
import { assertCanAccessAcademy, requireAuth } from '../http/auth';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import type { AppBindings } from '../http/types';
import { decryptCameraPassword } from '../security/cameraCrypto';
import { parseTimestamp, validateRange } from '../services/video/datetime';
import { VideoExtractorError } from '../services/video/errors';
import { createClipJob, getClipJob, isClipRate, setClipPosition, type ClipJob } from '../services/video/jobs';

export const clipRoutes = new Hono<AppBindings>();

clipRoutes.use('*', requireAuth);

const createClipSchema = z.object({
	cameraId: z.string().uuid(),
	start: z.string().min(1),
	end: z.string().min(1)
});

type CameraListRow = {
	id: string;
	academyId: string;
	dvrId: string;
	dvrName: string;
	name: string;
	channel: number;
	isDefault: boolean;
	sortOrder: number;
};

function parseClipDate(value: string) {
	try {
		return parseTimestamp(value, env.video.timeZone);
	} catch (error) {
		if (error instanceof VideoExtractorError) throw badRequest(error.message, error.details);
		throw error;
	}
}

async function assertAttendanceClipAccess(userId: string, academyId: string, receptionistId: string, user: AppBindings['Variables']['user']) {
	if (receptionistId !== userId) assertCanAccessAcademy(user, academyId);
}

function publicJob(job: ClipJob) {
	return {
		id: job.id,
		attendanceId: job.attendanceId,
		cameraId: job.cameraId,
		cameraName: job.cameraName,
		status: job.status,
		message: job.message,
		progress: job.progress,
		error: job.error,
		durationSeconds: job.durationSeconds,
		positionSeconds: job.positionSeconds,
		rate: job.rate,
		actualRate: job.actualRate,
		streamSeq: job.streamSeq,
		start: job.start,
		end: job.end,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
		expiresAt: job.expiresAt
	};
}

clipRoutes.get('/clips/cameras', async (c) => {
	const user = c.get('user');
	const academyId = c.req.query('academyId');
	if (!academyId) throw badRequest('Informe a academia.');
	assertCanAccessAcademy(user, academyId);

	const cameras = await sql<CameraListRow[]>`
		SELECT
			c."id",
			d."academy_id" AS "academyId",
			d."id" AS "dvrId",
			d."name" AS "dvrName",
			c."name",
			c."channel",
			c."is_default" AS "isDefault",
			c."sort_order" AS "sortOrder"
		FROM "gym-conversion-tracker"."academy_cameras" c
		JOIN "gym-conversion-tracker"."academy_dvrs" d ON d."id" = c."dvr_id"
		WHERE d."academy_id" = ${academyId}
			AND d."active" = true
			AND c."active" = true
		ORDER BY c."is_default" DESC, c."sort_order", c."name"
	`;

	return c.json({ cameras, maxDurationMinutes: env.video.clipMaxMinutes });
});

clipRoutes.post('/attendances/:id/clips', async (c) => {
	const user = c.get('user');
	const attendanceId = c.req.param('id');
	const input = createClipSchema.parse(await c.req.json());

	const [attendance] = await sql<Array<{ academy_id: string; receptionist_id: string }>>`
		SELECT "academy_id", "receptionist_id"
		FROM "gym-conversion-tracker"."attendances"
		WHERE "id" = ${attendanceId}
	`;
	if (!attendance) throw notFound();
	await assertAttendanceClipAccess(user.id, attendance.academy_id, attendance.receptionist_id, user);

	const start = parseClipDate(input.start);
	const end = parseClipDate(input.end);
	try {
		validateRange(start, end);
	} catch (error) {
		if (error instanceof VideoExtractorError) throw badRequest(error.message, error.details);
		throw error;
	}
	const durationMs = end.getTime() - start.getTime();
	if (durationMs > env.video.clipMaxMinutes * 60 * 1000) {
		throw badRequest(`O clipe pode ter no maximo ${env.video.clipMaxMinutes} minutos.`);
	}
	if (end.getTime() > Date.now() + 30_000) throw badRequest('O intervalo do clipe nao pode estar no futuro.');

	const [camera] = await sql<
		Array<{
			id: string;
			name: string;
			channel: number;
			host: string;
			rtsp_port: number;
			http_port: number;
			username: string;
			password_encrypted: string;
		}>
	>`
		SELECT
			c."id",
			c."name",
			c."channel",
			d."host",
			d."rtsp_port",
			d."http_port",
			d."username",
			d."password_encrypted"
		FROM "gym-conversion-tracker"."academy_cameras" c
		JOIN "gym-conversion-tracker"."academy_dvrs" d ON d."id" = c."dvr_id"
		WHERE c."id" = ${input.cameraId}
			AND c."active" = true
			AND d."active" = true
			AND d."academy_id" = ${attendance.academy_id}
	`;
	if (!camera) throw badRequest('Camera invalida para este atendimento.');

	const job = createClipJob({
		userId: user.id,
		attendanceId,
		cameraId: camera.id,
		cameraName: camera.name,
		channel: camera.channel,
		start,
		end,
		dvr: {
			host: camera.host,
			rtspPort: camera.rtsp_port,
			httpPort: camera.http_port,
			username: camera.username,
			password: decryptCameraPassword(camera.password_encrypted)
		}
	});

	return c.json({ job: publicJob(job) }, 202);
});

clipRoutes.get('/clips/jobs/:jobId', async (c) => {
	const user = c.get('user');
	const job = getClipJob(c.req.param('jobId'));
	if (!job) throw notFound();
	if (job.userId !== user.id) throw forbidden();
	return c.json({ job: publicJob(job) });
});

const STREAM_POLL_MS = 300;
const STREAM_CHUNK_BYTES = 1024 * 1024;

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function clipHeaders(filename: string) {
	return {
		'Content-Type': 'video/mp4',
		'Content-Disposition': `inline; filename="${filename.replace(/"/g, '')}"`
	};
}

function parseAt(value: string | undefined): number {
	if (!value) return 0;
	const at = Number(value);
	if (!Number.isFinite(at) || at < 0) throw badRequest('Ponto inicial do clipe invalido.');
	return at;
}

function parseRate(value: string | undefined) {
	const rate = Number(value ?? 8);
	if (!isClipRate(rate)) throw badRequest('Velocidade invalida para o clipe.');
	return rate;
}

function streamGrowingClip(jobId: string, streamSeq: number): ReadableStream<Uint8Array> {
	let cancelled = false;
	return new ReadableStream<Uint8Array>({
		start(controller) {
			void (async () => {
				let offset = 0;
				try {
					while (!cancelled) {
						const currentJob = getClipJob(jobId);
						if (!currentJob || currentJob.streamSeq !== streamSeq) {
							controller.close();
							return;
						}
						if (currentJob.status === 'failed') {
							controller.close();
							return;
						}
						if (!currentJob.partialPath) {
							controller.close();
							return;
						}

						const file = Bun.file(currentJob.partialPath);
						if (await file.exists()) {
							const size = file.size;
							if (size > offset) {
								const end = Math.min(size, offset + STREAM_CHUNK_BYTES);
								const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
								if (chunk.length > 0) {
									controller.enqueue(chunk);
									offset = end;
									continue;
								}
							}

							if (currentJob.status === 'idle') {
								controller.close();
								return;
							}
						}

						await delay(STREAM_POLL_MS);
					}
				} catch (error) {
					if (!cancelled) controller.error(error);
				}
			})();
		},
		cancel() {
			cancelled = true;
		}
	});
}

clipRoutes.get('/clips/jobs/:jobId/stream', async (c) => {
	const user = c.get('user');
	const job = getClipJob(c.req.param('jobId'));
	if (!job) throw notFound();
	if (job.userId !== user.id) throw forbidden();
	const positioned = await setClipPosition(job.id, parseAt(c.req.query('at')), parseRate(c.req.query('rate')));
	if (!positioned) throw notFound();
	if (positioned.status === 'failed') throw conflict(positioned.error || 'Falha ao gerar o clipe.');
	if (!positioned.partialPath) throw conflict('Ponto do clipe nao possui stream ativo.');

	return new Response(streamGrowingClip(positioned.id, positioned.streamSeq), {
		status: 200,
		headers: {
			...clipHeaders(`${positioned.id}.${positioned.streamSeq}.mp4`),
			'Cache-Control': 'no-store'
		}
	});
});
