import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../../config/env';
import { formatDvrTimestamp } from './datetime';
import { ensureFfmpegTools, runFfmpegDownload } from './ffmpeg';
import { buildPlaybackUrl, type DvrCredentials } from './intelbras';
import { CLIP_RATES, probeScaleSupport, startScaledRtspProxy, type ClipRate, type ScaledRtspProxy } from './rtspScale';

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

export type ClipPullState = 'pulling' | 'complete' | 'failed';

export type ClipPull = {
	seq: number;
	atSeconds: number;
	requestedRate: ClipRate;
	actualRate: ClipRate;
	path: string;
	state: ClipPullState;
	error?: string;
	createdAt: number;
	updatedAt: number;
	abort: AbortController;
	proxy?: ScaledRtspProxy;
};

type InternalClipJob = ClipJob & {
	input: CreateClipJobInput;
	pulls: Map<string, ClipPull>;
};

const jobs = new Map<string, InternalClipJob>();
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
let activeJobs = 0;
const waiters: Array<() => void> = [];
const MAX_RETAINED_PULLS = 3;

export function isClipRate(value: number): value is ClipRate {
	return CLIP_RATES.includes(value as ClipRate);
}

function updateJob(id: string, patch: Partial<ClipJob>) {
	const current = jobs.get(id);
	if (!current) return;
	jobs.set(id, { ...current, ...patch, updatedAt: new Date().toISOString() });
}

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
		if (job) stopPulls(job);
		jobs.delete(id);
		cleanupTimers.delete(id);
		if (job) {
			for (const pull of job.pulls.values()) {
				void unlinkWithRetry(pull.path);
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

function pullKey(atSeconds: number, rate: ClipRate) {
	return `${atSeconds}:${rate}`;
}

function stopPull(pull: ClipPull) {
	if (pull.state === 'pulling') {
		pull.abort.abort();
		pull.state = 'failed';
		pull.error = 'Pull substituido.';
	}
	pull.proxy?.close();
	pull.proxy = undefined;
	pull.updatedAt = Date.now();
}

function stopPulls(job: InternalClipJob, keepPull?: ClipPull) {
	for (const [key, pull] of [...job.pulls.entries()]) {
		if (pull === keepPull || pull.state !== 'pulling') continue;
		stopPull(pull);
		job.pulls.delete(key);
		void unlinkWithRetry(pull.path);
	}
}

async function unlinkWithRetry(path: string) {
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			await unlink(path);
			return;
		} catch {
			if (attempt === 3) return;
			await delay(250);
		}
	}
}

function prunePulls(job: InternalClipJob, keepPull?: ClipPull) {
	const sorted = [...job.pulls.entries()]
		.filter(([, pull]) => pull.state !== 'pulling')
		.sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
	const retained = new Set(sorted.slice(0, MAX_RETAINED_PULLS).map(([key]) => key));
	for (const [key, pull] of sorted) {
		if (pull === keepPull || retained.has(key)) continue;
		job.pulls.delete(key);
		void unlinkWithRetry(pull.path);
	}
}

async function runSession(id: string, seq: number) {
	const job = jobs.get(id);
	const pull = [...(job?.pulls.values() ?? [])].find((candidate) => candidate.seq === seq);
	if (!job || !pull || pull.state !== 'pulling') return;
	const input = job.input;
	const remainingSeconds = Math.max(1, durationSeconds(input) - pull.atSeconds);
	let acquiredSlot = false;
	try {
		await acquireSlot();
		acquiredSlot = true;
		const current = jobs.get(id);
		const currentPull = [...(current?.pulls.values() ?? [])].find((candidate) => candidate.seq === seq);
		if (!current || currentPull !== pull || pull.state !== 'pulling' || pull.abort.signal.aborted) return;

		await mkdir(env.video.clipDir, { recursive: true });
		await unlink(pull.path).catch(() => undefined);
		await ensureFfmpegTools();

		const start = new Date(input.start.getTime() + pull.atSeconds * 1000);
		const playback = buildPlaybackUrl({
			...input.dvr,
			channel: input.channel,
			startDvr: formatDvrTimestamp(start, env.video.timeZone),
			endDvr: formatDvrTimestamp(input.end, env.video.timeZone)
		});

		const secrets = [playback.url, input.dvr.password, encodeURIComponent(input.dvr.password)];
		let inputArgs: string[] | undefined;
		pull.actualRate = 1;
		pull.updatedAt = Date.now();
		if (pull.requestedRate > 1) {
			const accepted = await probeScaleSupport({
				url: playback.url,
				redactedUrl: playback.redacted,
				username: input.dvr.username,
				password: input.dvr.password,
				rate: pull.requestedRate
			});
			if (accepted && !pull.abort.signal.aborted) {
				pull.proxy = await startScaledRtspProxy({ url: playback.url, rate: accepted });
				inputArgs = ['-rtsp_transport', 'tcp', '-i', pull.proxy.url];
				pull.actualRate = accepted;
				pull.updatedAt = Date.now();
				secrets.push(pull.proxy.url);
			}
		}

		updateJob(id, {
			status: 'pulling',
			message:
				pull.actualRate > 1
					? `Buscando gravacao no DVR em ${pull.actualRate}x.`
					: pull.requestedRate > 1
						? 'DVR nao aceitou velocidade alta; buscando em 1x.'
						: 'Buscando gravacao no DVR.',
			actualRate: pull.actualRate
		});

		await runFfmpegDownload({
			url: playback.url,
			redactedUrl: playback.redacted,
			secrets,
			durationSeconds: remainingSeconds,
			rate: pull.actualRate,
			outputPath: pull.path,
			inputArgs,
			signal: pull.abort.signal,
			onProgress: (progress) => {
				const positionSeconds = Math.min(durationSeconds(input), pull.atSeconds + (remainingSeconds * progress) / 100);
				pull.updatedAt = Date.now();
				updateJob(id, {
					positionSeconds,
					progress: Math.max(1, Math.min(100, Math.round((positionSeconds / durationSeconds(input)) * 100))),
					message: `Carregando trecho (${Math.round(progress)}%).`
				});
			}
		});

		const completedJob = jobs.get(id);
		if (!pull.abort.signal.aborted && completedJob?.pulls.get(pullKey(pull.atSeconds, pull.requestedRate)) === pull) {
			pull.state = 'complete';
			pull.updatedAt = Date.now();
			updateJob(id, {
				status: 'idle',
				message: 'Trecho carregado ate o fim.',
				positionSeconds: durationSeconds(input),
				progress: 100
			});
			prunePulls(completedJob, pull);
		}
	} catch (error) {
		if (pull.abort.signal.aborted) return;
		const message = error instanceof Error ? error.message : 'Falha ao gerar clipe.';
		pull.state = 'failed';
		pull.error = message;
		pull.updatedAt = Date.now();
		updateJob(id, {
			status: 'failed',
			message: 'Falha ao carregar trecho do clipe.',
			error: message,
			progress: 0
		});
	} finally {
		pull.proxy?.close();
		pull.proxy = undefined;
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
		pulls: new Map()
	};
	jobs.set(id, job);
	scheduleCleanup(id);
	return job;
}

export function getClipJob(id: string): InternalClipJob | undefined {
	return jobs.get(id);
}

export function getClipPull(id: string, seq: number): ClipPull | undefined {
	const job = jobs.get(id);
	return [...(job?.pulls.values() ?? [])].find((pull) => pull.seq === seq);
}

export async function setClipPosition(id: string, atSeconds: number, rate: ClipRate): Promise<{ job: InternalClipJob; pull?: ClipPull } | undefined> {
	const job = jobs.get(id);
	if (!job) return undefined;
	const at = clampPosition(job.input, atSeconds);
	if (at >= job.durationSeconds) {
		stopPulls(job);
		updateJob(id, {
			status: 'idle',
			message: 'Fim do recorte.',
			positionSeconds: job.durationSeconds,
			progress: 100,
			rate,
			actualRate: rate,
			partialPath: undefined
		});
		const updated = jobs.get(id);
		return updated ? { job: updated } : undefined;
	}

	const key = pullKey(at, rate);
	const existingPull = job.pulls.get(key);
	if (existingPull && existingPull.state !== 'failed') {
		updateJob(id, {
			status: existingPull.state === 'pulling' ? 'pulling' : 'idle',
			message: existingPull.state === 'pulling' ? job.message : 'Trecho carregado ate o fim.',
			error: undefined,
			positionSeconds: existingPull.state === 'complete' ? job.durationSeconds : at,
			rate,
			actualRate: existingPull.actualRate,
			streamSeq: existingPull.seq,
			partialPath: existingPull.path
		});
		const updated = jobs.get(id);
		return updated ? { job: updated, pull: existingPull } : undefined;
	}
	if (existingPull) {
		job.pulls.delete(key);
		void unlinkWithRetry(existingPull.path);
	}

	stopPulls(job);
	const seq = job.streamSeq + 1;
	const partialPath = join(env.video.clipDir, `${id}.${seq}.partial.mp4`);
	const now = Date.now();
	const pull: ClipPull = {
		seq,
		atSeconds: at,
		requestedRate: rate,
		actualRate: rate,
		path: partialPath,
		state: 'pulling',
		createdAt: now,
		updatedAt: now,
		abort: new AbortController()
	};
	job.pulls.set(key, pull);
	prunePulls(job, pull);
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
	const updated = jobs.get(id);
	return updated ? { job: updated, pull } : undefined;
}
