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
import { createClipJob, getClipJob } from '../services/video/jobs';

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

function publicJob(job: NonNullable<ReturnType<typeof getClipJob>>) {
	return {
		id: job.id,
		attendanceId: job.attendanceId,
		cameraId: job.cameraId,
		cameraName: job.cameraName,
		status: job.status,
		message: job.message,
		progress: job.progress,
		error: job.error,
		sizeBytes: job.sizeBytes,
		durationSeconds: job.durationSeconds,
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

function parseRangeHeader(range: string | undefined, size: number): { start: number; end: number } | null {
	if (!range) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(range);
	if (!match) return null;
	if (!match[1] && !match[2]) return null;
	let start = match[1] ? Number(match[1]) : 0;
	let end = match[2] ? Number(match[2]) : size - 1;
	if (!match[1] && match[2]) {
		const suffixLength = Number(match[2]);
		start = Math.max(size - suffixLength, 0);
		end = size - 1;
	}
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= size || start > end) return null;
	return { start, end };
}

clipRoutes.get('/clips/jobs/:jobId/stream', async (c) => {
	const user = c.get('user');
	const job = getClipJob(c.req.param('jobId'));
	if (!job) throw notFound();
	if (job.userId !== user.id) throw forbidden();
	if (job.status !== 'completed' || !job.filePath) throw conflict('O clipe ainda nao esta pronto.');

	const file = Bun.file(job.filePath);
	if (!(await file.exists())) throw notFound('Arquivo do clipe nao encontrado. Gere o clipe novamente.');
	const size = file.size;
	const filename = job.fileName ?? `${job.id}.mp4`;
	const range = parseRangeHeader(c.req.header('range'), size);
	const baseHeaders = {
		'Accept-Ranges': 'bytes',
		'Content-Type': 'video/mp4',
		'Content-Disposition': `inline; filename="${filename.replace(/"/g, '')}"`
	};

	if (!range) {
		return new Response(file.stream(), {
			status: 200,
			headers: {
				...baseHeaders,
				'Content-Length': String(size)
			}
		});
	}

	const body = file.slice(range.start, range.end + 1);
	return new Response(body.stream(), {
		status: 206,
		headers: {
			...baseHeaders,
			'Content-Length': String(range.end - range.start + 1),
			'Content-Range': `bytes ${range.start}-${range.end}/${size}`
		}
	});
});
