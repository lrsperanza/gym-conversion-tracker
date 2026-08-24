import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../../config/env';
import { formatDvrTimestamp } from './datetime';
import { ensureFfmpegTools, runFfmpegDownload } from './ffmpeg';
import { buildPlaybackUrl, type DvrCredentials } from './intelbras';
import { openScaledPlayback, type ClipRate, type ScaledPlaybackSession } from './rtspScale';

export type ClipJobStatus = 'idle' | 'pulling' | 'failed';

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
	durationSeconds: number;
	positionSeconds: number;
	rate: ClipRate;
	actualRate: ClipRate;
	streamSeq: number;
	partialPath?: string;
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

type ActiveSession = {
	seq: number;
	atSeconds: number;
	requestedRate: ClipRate;
	actualRate: ClipRate;
	partialPath: string;
	abort: AbortController;
	scaled?: ScaledPlaybackSession;
};

type InternalClipJob = ClipJob & {
	input: CreateClipJobInput;
	session?: ActiveSession;
	partialPaths: Set<string>;
};

const jobs = new Map<string, InternalClipJob>();
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
let activeJobs = 0;
const waiters: Array<() => void> = [];

export const CLIP_RATES: ClipRate[] = [1, 2, 4, 8];

export function isClipRate(value: number): value is ClipRate {
	return CLIP_RATES.includes(value as ClipRate);
}

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
		if (job) stopSession(job);
		jobs.delete(id);
		cleanupTimers.delete(id);
		if (job) {
			for (const path of job.partialPaths) {
				void unlink(path).catch(() => undefined);
			}
		}
	}, env.video.clipTtlMinutes * 60 * 1000);
	cleanupTimers.set(id, timer);
}

function durationSeconds(input: CreateClipJobInput) {
	return Math.ceil((input.end.getTime() - input.start.getTime()) / 1000);
}

function clampPosition(input: CreateClipJobInput, atSeconds: number) {
	const duration = durationSeconds(input);
	if (!Number.isFinite(atSeconds)) return 0;
	return Math.max(0, Math.min(duration, Math.floor(atSeconds)));
}

function stopSession(job: InternalClipJob) {
	job.session?.abort.abort();
	job.session?.scaled?.close();
	job.session = undefined;
}

function deleteOldPartials(job: InternalClipJob, keepPath: string) {
	for (const path of [...job.partialPaths]) {
		if (path === keepPath) continue;
		job.partialPaths.delete(path);
		void unlink(path).catch(() => undefined);
	}
}

async function runSession(id: string, seq: number) {
	const job = jobs.get(id);
	if (!job?.session || job.session.seq !== seq) return;
	const session = job.session;
	const input = job.input;
	const remainingSeconds = Math.max(1, durationSeconds(input) - session.atSeconds);
	let acquiredSlot = false;
	try {
		await acquireSlot();
		acquiredSlot = true;
		const current = jobs.get(id);
		if (!current?.session || current.session.seq !== seq || session.abort.signal.aborted) return;

		await mkdir(env.video.clipDir, { recursive: true });
		await unlink(session.partialPath).catch(() => undefined);
		await ensureFfmpegTools();

		const start = new Date(input.start.getTime() + session.atSeconds * 1000);
		const playback = buildPlaybackUrl({
			...input.dvr,
			channel: input.channel,
			startDvr: formatDvrTimestamp(start, env.video.timeZone),
			endDvr: formatDvrTimestamp(input.end, env.video.timeZone)
		});

		let inputArgs: string[] | undefined;
		if (session.requestedRate > 1) {
			session.scaled =
				(await openScaledPlayback({
					url: playback.url,
					redactedUrl: playback.redacted,
					username: input.dvr.username,
					password: input.dvr.password,
					rate: session.requestedRate,
					sdpDir: env.video.clipDir
				})) ?? undefined;
			if (session.scaled) {
				inputArgs = session.scaled.inputArgs;
				session.actualRate = session.scaled.actualRate;
			} else {
				session.actualRate = 1;
			}
		}

		updateJob(id, {
			status: 'pulling',
			message:
				session.actualRate > 1
					? `Buscando gravacao no DVR em ${session.actualRate}x.`
					: session.requestedRate > 1
						? 'DVR nao aceitou velocidade alta; buscando em 1x.'
						: 'Buscando gravacao no DVR.',
			actualRate: session.actualRate
		});

		await runFfmpegDownload({
			url: playback.url,
			redactedUrl: playback.redacted,
			secrets: [playback.url, input.dvr.password, encodeURIComponent(input.dvr.password)],
			durationSeconds: remainingSeconds,
			outputPath: session.partialPath,
			inputArgs,
			signal: session.abort.signal,
			onProgress: (progress) => {
				const positionSeconds = Math.min(durationSeconds(input), session.atSeconds + (remainingSeconds * progress) / 100);
				updateJob(id, {
					positionSeconds,
					progress: Math.max(1, Math.min(100, Math.round((positionSeconds / durationSeconds(input)) * 100))),
					message: `Carregando trecho (${Math.round(progress)}%).`
				});
			}
		});

		if (!session.abort.signal.aborted && jobs.get(id)?.session?.seq === seq) {
			updateJob(id, {
				status: 'idle',
				message: 'Trecho carregado ate o fim.',
				positionSeconds: durationSeconds(input),
				progress: 100
			});
			jobs.get(id)!.session = undefined;
		}
	} catch (error) {
		if (session.abort.signal.aborted) return;
		const message = error instanceof Error ? error.message : 'Falha ao gerar clipe.';
		updateJob(id, {
			status: 'failed',
			message: 'Falha ao carregar trecho do clipe.',
			error: message,
			progress: 0
		});
	} finally {
		session.scaled?.close();
		if (acquiredSlot) releaseSlot();
		scheduleCleanup(id);
	}
}

export function createClipJob(input: CreateClipJobInput): ClipJob {
	const id = crypto.randomUUID();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + env.video.clipTtlMinutes * 60 * 1000);
	const job: InternalClipJob = {
		id,
		userId: input.userId,
		attendanceId: input.attendanceId,
		cameraId: input.cameraId,
		cameraName: input.cameraName,
		status: 'idle',
		message: 'Escolha um ponto do recorte para iniciar o playback.',
		progress: 0,
		durationSeconds: durationSeconds(input),
		positionSeconds: 0,
		rate: 8,
		actualRate: 8,
		streamSeq: 0,
		start: input.start.toISOString(),
		end: input.end.toISOString(),
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
		expiresAt: expiresAt.toISOString(),
		input,
		partialPaths: new Set()
	};
	jobs.set(id, job);
	scheduleCleanup(id);
	return job;
}

export function getClipJob(id: string): InternalClipJob | undefined {
	return jobs.get(id);
}

export async function setClipPosition(id: string, atSeconds: number, rate: ClipRate): Promise<InternalClipJob | undefined> {
	const job = jobs.get(id);
	if (!job) return undefined;
	const at = clampPosition(job.input, atSeconds);
	if (at >= job.durationSeconds) {
		stopSession(job);
		updateJob(id, {
			status: 'idle',
			message: 'Fim do recorte.',
			positionSeconds: job.durationSeconds,
			progress: 100,
			rate,
			actualRate: rate,
			partialPath: undefined
		});
		return jobs.get(id);
	}

	if (job.session && job.session.requestedRate === rate && Math.abs(job.session.atSeconds - at) < 1) return job;

	stopSession(job);
	const seq = job.streamSeq + 1;
	const partialPath = join(env.video.clipDir, `${id}.${seq}.partial.mp4`);
	job.partialPaths.add(partialPath);
	deleteOldPartials(job, partialPath);
	const session: ActiveSession = {
		seq,
		atSeconds: at,
		requestedRate: rate,
		actualRate: rate,
		partialPath,
		abort: new AbortController()
	};
	job.session = session;
	updateJob(id, {
		status: 'pulling',
		message: 'Aguardando o DVR iniciar o playback.',
		error: undefined,
		progress: Math.max(0, Math.min(100, Math.round((at / job.durationSeconds) * 100))),
		positionSeconds: at,
		rate,
		actualRate: rate,
		streamSeq: seq,
		partialPath
	});
	void runSession(id, seq);
	return jobs.get(id);
}
