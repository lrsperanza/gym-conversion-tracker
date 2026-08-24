import { mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../../config/env';
import { formatDvrTimestamp, formatFilenameTimestamp } from './datetime';
import { ensureFfmpegTools, probeFile, runFfmpegDownload } from './ffmpeg';
import { buildPlaybackUrl, type DvrCredentials } from './intelbras';
import { VideoExtractorError } from './errors';

export type ClipJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export type ClipJob = {
	id: string;
	userId: string;
	attendanceId: string;
	cameraId: string;
	cameraName: string;
	status: ClipJobStatus;
	message: string;
	progress: number;
	error?: string;
	filePath?: string;
	fileName?: string;
	sizeBytes?: number;
	durationSeconds?: number | null;
	start: string;
	end: string;
	createdAt: string;
	updatedAt: string;
	expiresAt: string;
};

export type CreateClipJobInput = {
	userId: string;
	attendanceId: string;
	cameraId: string;
	cameraName: string;
	channel: number;
	start: Date;
	end: Date;
	dvr: DvrCredentials;
};

const jobs = new Map<string, ClipJob>();
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
let activeJobs = 0;
const waiters: Array<() => void> = [];

function updateJob(id: string, patch: Partial<ClipJob>) {
	const current = jobs.get(id);
	if (!current) return;
	jobs.set(id, { ...current, ...patch, updatedAt: new Date().toISOString() });
}

async function acquireSlot() {
	if (activeJobs < env.video.maxConcurrent) {
		activeJobs += 1;
		return;
	}
	await new Promise<void>((resolve) => waiters.push(resolve));
	activeJobs += 1;
}

function releaseSlot() {
	activeJobs = Math.max(0, activeJobs - 1);
	const next = waiters.shift();
	if (next) next();
}

function scheduleCleanup(id: string) {
	const existing = cleanupTimers.get(id);
	if (existing) clearTimeout(existing);
	const timer = setTimeout(() => {
		const job = jobs.get(id);
		jobs.delete(id);
		cleanupTimers.delete(id);
		if (job?.filePath) {
			void unlink(job.filePath).catch(() => undefined);
		}
	}, env.video.clipTtlMinutes * 60 * 1000);
	cleanupTimers.set(id, timer);
}

function safeSegment(value: string) {
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9_-]+/gi, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48)
		.toLowerCase();
}

async function runJob(id: string, input: CreateClipJobInput) {
	await acquireSlot();
	const partialPath = join(env.video.clipDir, `${id}.partial.mp4`);
	try {
		updateJob(id, { status: 'running', message: 'Gerando clipe a partir da gravacao do DVR.', progress: 1 });
		await mkdir(env.video.clipDir, { recursive: true });
		await ensureFfmpegTools();

		const startDvr = formatDvrTimestamp(input.start, env.video.timeZone);
		const endDvr = formatDvrTimestamp(input.end, env.video.timeZone);
		const durationSeconds = Math.ceil((input.end.getTime() - input.start.getTime()) / 1000);
		const playback = buildPlaybackUrl({
			...input.dvr,
			channel: input.channel,
			startDvr,
			endDvr
		});
		const outputPath = join(
			env.video.clipDir,
			`${safeSegment(input.cameraName) || 'camera'}_${formatFilenameTimestamp(input.start, env.video.timeZone)}_${formatFilenameTimestamp(input.end, env.video.timeZone)}_${id}.mp4`
		);

		await runFfmpegDownload({
			url: playback.url,
			redactedUrl: playback.redacted,
			secrets: [playback.url, input.dvr.password, encodeURIComponent(input.dvr.password)],
			durationSeconds,
			outputPath: partialPath,
			onProgress: (progress) => {
				updateJob(id, {
					progress: Math.max(1, Math.min(99, Math.round(progress))),
					message: `Gerando clipe (${Math.round(progress)}%).`
				});
			}
		});

		const probe = await probeFile(partialPath);
		if (!probe.hasVideo) {
			throw new VideoExtractorError('VALIDATION_FAILED', 'O arquivo gerado nao contem video.');
		}
		await rename(partialPath, outputPath);
		updateJob(id, {
			status: 'completed',
			message: 'Clipe pronto para revisao.',
			progress: 100,
			filePath: outputPath,
			fileName: outputPath.split(/[\\/]/).pop(),
			sizeBytes: probe.sizeBytes,
			durationSeconds: probe.durationSeconds
		});
	} catch (error) {
		await unlink(partialPath).catch(() => undefined);
		const message = error instanceof Error ? error.message : 'Falha ao gerar clipe.';
		updateJob(id, {
			status: 'failed',
			message: 'Falha ao gerar clipe.',
			error: message,
			progress: 0
		});
	} finally {
		releaseSlot();
		scheduleCleanup(id);
	}
}

export function createClipJob(input: CreateClipJobInput): ClipJob {
	const id = crypto.randomUUID();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + env.video.clipTtlMinutes * 60 * 1000);
	const job: ClipJob = {
		id,
		userId: input.userId,
		attendanceId: input.attendanceId,
		cameraId: input.cameraId,
		cameraName: input.cameraName,
		status: 'queued',
		message: 'Clipe aguardando vaga para processamento.',
		progress: 0,
		start: input.start.toISOString(),
		end: input.end.toISOString(),
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
		expiresAt: expiresAt.toISOString()
	};
	jobs.set(id, job);
	scheduleCleanup(id);
	void runJob(id, input);
	return job;
}

export function getClipJob(id: string): ClipJob | undefined {
	return jobs.get(id);
}
