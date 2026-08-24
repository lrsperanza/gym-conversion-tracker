import { mkdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { env } from '../config/env';
import { closeDb, sql } from '../db/client';
import { decryptCameraPassword } from '../security/cameraCrypto';
import { formatDvrTimestamp, formatFilenameTimestamp, parseTimestamp, validateRange } from '../services/video/datetime';
import { ensureFfmpegTools, probeFile, runFfmpegDownload } from '../services/video/ffmpeg';
import { buildPlaybackUrl } from '../services/video/intelbras';
import { probeScaleSupport, startScaledRtspProxy, type ClipRate, type ScaledRtspProxy } from '../services/video/rtspScale';

type Args = {
	cameraId?: string;
	start?: string;
	end?: string;
	at?: number;
	rate?: ClipRate;
	outputDir?: string;
};

function parseArgs(argv: string[]): Args {
	const args: Args = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === '--camera-id') {
			args.cameraId = next;
			i += 1;
		} else if (arg === '--start') {
			args.start = next;
			i += 1;
		} else if (arg === '--end') {
			args.end = next;
			i += 1;
		} else if (arg === '--at') {
			const value = Number(next);
			if (Number.isFinite(value)) args.at = value;
			i += 1;
		} else if (arg === '--rate') {
			const value = Number(next);
			if (value === 1 || value === 2 || value === 4 || value === 8) args.rate = value;
			i += 1;
		} else if (arg === '--output-dir') {
			args.outputDir = next;
			i += 1;
		}
	}
	return args;
}

async function main() {
	const args = parseArgs(Bun.argv.slice(2));
	if (!args.cameraId || !args.start || !args.end) {
		throw new Error('Uso: bun run clip:extract -- --camera-id <uuid> --start "2026-08-24T09:30:00-03:00" --end "2026-08-24T09:35:00-03:00" [--output-dir ./clips]');
	}

	const start = parseTimestamp(args.start, env.video.timeZone);
	const end = parseTimestamp(args.end, env.video.timeZone);
	validateRange(start, end);
	const requestedRate = args.rate ?? 1;
	const atSeconds = Math.max(0, Math.floor(args.at ?? 0));
	const effectiveStart = new Date(Math.min(start.getTime() + atSeconds * 1000, end.getTime()));

	const [camera] = await sql<
		Array<{
			camera_id: string;
			camera_name: string;
			channel: number;
			host: string;
			rtsp_port: number;
			http_port: number;
			username: string;
			password_encrypted: string;
		}>
	>`
		SELECT
			c."id" AS "camera_id",
			c."name" AS "camera_name",
			c."channel",
			d."host",
			d."rtsp_port",
			d."http_port",
			d."username",
			d."password_encrypted"
		FROM "gym-conversion-tracker"."academy_cameras" c
		JOIN "gym-conversion-tracker"."academy_dvrs" d ON d."id" = c."dvr_id"
		WHERE c."id" = ${args.cameraId}
			AND c."active" = true
			AND d."active" = true
	`;
	if (!camera) throw new Error('Camera ativa nao encontrada.');

	await ensureFfmpegTools();
	const password = decryptCameraPassword(camera.password_encrypted);
	const playback = buildPlaybackUrl({
		host: camera.host,
		rtspPort: camera.rtsp_port,
		httpPort: camera.http_port,
		username: camera.username,
		password,
		channel: camera.channel,
			startDvr: formatDvrTimestamp(effectiveStart, env.video.timeZone),
		endDvr: formatDvrTimestamp(end, env.video.timeZone)
	});

	const outputDir = resolve(args.outputDir ?? env.video.clipDir);
	await mkdir(outputDir, { recursive: true });
	const fileName = `${camera.camera_name}_${formatFilenameTimestamp(start, env.video.timeZone)}_${formatFilenameTimestamp(end, env.video.timeZone)}.mp4`
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9_.-]+/gi, '-');
	const outputPath = join(outputDir, fileName);
	const partialPath = `${outputPath}.partial.mp4`;
	const durationSeconds = Math.max(1, Math.ceil((end.getTime() - effectiveStart.getTime()) / 1000));
	const secrets = [playback.url, password, encodeURIComponent(password)];
	let proxy: ScaledRtspProxy | null = null;
	let inputArgs: string[] | undefined;
	let acceptedRate: ClipRate = 1;
	if (requestedRate > 1) {
		const accepted = await probeScaleSupport({
			url: playback.url,
			redactedUrl: playback.redacted,
			username: camera.username,
			password,
			rate: requestedRate
		});
		if (accepted) {
			proxy = await startScaledRtspProxy({ url: playback.url, rate: accepted });
			inputArgs = ['-rtsp_transport', 'tcp', '-i', proxy.url];
			acceptedRate = accepted;
			secrets.push(proxy.url);
			console.info(`Velocidade negociada com DVR: ${accepted}x`);
		} else {
			console.info('DVR nao aceitou velocidade alta; usando fallback 1x.');
		}
	}

	try {
		await runFfmpegDownload({
			url: playback.url,
			redactedUrl: playback.redacted,
			secrets,
			durationSeconds,
			outputPath: partialPath,
			inputArgs,
			rate: acceptedRate,
			verbose: true,
			onProgress: (progress) => console.info(`Progresso: ${Math.round(progress)}%`)
		});
		const probe = await probeFile(partialPath);
		if (!probe.hasVideo) throw new Error('Arquivo gerado nao contem video.');
		await rename(partialPath, outputPath);
		console.info(outputPath);
	} finally {
		proxy?.close();
	}
}

main()
	.catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	})
	.finally(async () => {
		await closeDb();
	});
