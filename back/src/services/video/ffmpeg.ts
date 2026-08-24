import type { Subprocess } from 'bun';
import { VideoExtractorError, type VideoErrorCode } from './errors';

let activeFfmpeg: Subprocess | null = null;

export function killActiveFfmpeg(): void {
	try {
		activeFfmpeg?.kill();
	} catch {
		// Process already exited.
	}
}

export async function ensureFfmpegTools(): Promise<void> {
	for (const tool of ['ffmpeg', 'ffprobe']) {
		let ok = false;
		try {
			const proc = Bun.spawnSync([tool, '-version'], {
				stdout: 'ignore',
				stderr: 'ignore'
			});
			ok = proc.exitCode === 0;
		} catch {
			ok = false;
		}
		if (!ok) {
			throw new VideoExtractorError('FFMPEG_NOT_FOUND', `"${tool}" nao foi encontrado no PATH do servidor.`);
		}
	}
}

async function* streamLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let index: number;
			while ((index = buffer.indexOf('\n')) !== -1) {
				yield buffer.slice(0, index).replace(/\r$/, '');
				buffer = buffer.slice(index + 1);
			}
		}
		buffer += decoder.decode();
		if (buffer.trim() !== '') yield buffer;
	} finally {
		reader.releaseLock();
	}
}

export function classifyFfmpegError(stderr: string): { code: VideoErrorCode; message: string } {
	const text = stderr.toLowerCase();
	if (/401|unauthorized|authorization required|authentication/.test(text)) {
		return { code: 'AUTH_FAILED', message: 'O DVR rejeitou as credenciais configuradas para esta academia.' };
	}
	if (/connection refused|no route to host|network is unreachable/.test(text)) {
		return { code: 'DVR_UNREACHABLE', message: 'O DVR recusou a conexao ou a rota Tailscale ficou indisponivel.' };
	}
	if (/timed?\s*out|timeout/.test(text)) {
		return { code: 'RTSP_ERROR', message: 'Tempo esgotado aguardando o stream RTSP de gravacao do DVR.' };
	}
	if (/404|not found|no stream|invalid data found/.test(text)) {
		return {
			code: 'NO_RECORDING',
			message: 'O DVR nao encontrou gravacao para o intervalo/canal solicitado.'
		};
	}
	return { code: 'RTSP_ERROR', message: 'Falha ao recuperar a gravacao do DVR com FFmpeg.' };
}

export type DownloadOptions = {
	url: string;
	redactedUrl: string;
	secrets: string[];
	durationSeconds: number;
	outputPath: string;
	inputArgs?: string[];
	signal?: AbortSignal;
	verbose?: boolean;
	onProgress?: (pct: number) => void;
};

const STALL_TIMEOUT_MS = 30_000;

export function redactSecrets(text: string, secrets: string[]): string {
	let output = text;
	for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
		if (secret) output = output.split(secret).join('***');
	}
	return output;
}

type AttemptResult = {
	exitCode: number;
	stderrTail: string;
	killReason: string | null;
};

async function spawnAttempt(argv: string[], opts: DownloadOptions): Promise<AttemptResult> {
	const proc = Bun.spawn(argv, {
		stdout: 'pipe',
		stderr: 'pipe',
		stdin: 'ignore'
	});
	activeFfmpeg = proc;

	const startedAt = Date.now();
	let lastActivity = startedAt;
	const overallTimeoutMs = Math.max(180_000, opts.durationSeconds * 3000 + 120_000);
	let killReason: string | null = null;
	const abort = () => {
		killReason = 'Processamento do clipe cancelado.';
		try {
			proc.kill();
		} catch {
			// Process already exited.
		}
	};
	opts.signal?.addEventListener('abort', abort, { once: true });
	if (opts.signal?.aborted) abort();

	const watchdog = setInterval(() => {
		const now = Date.now();
		if (now - lastActivity > STALL_TIMEOUT_MS) {
			killReason = `Nenhum dado recebido do DVR por ${STALL_TIMEOUT_MS / 1000}s.`;
			try {
				proc.kill();
			} catch {
				// Process already exited.
			}
		} else if (now - startedAt > overallTimeoutMs) {
			killReason = `Tempo maximo de ${Math.round(overallTimeoutMs / 1000)}s excedido para gerar o clipe.`;
			try {
				proc.kill();
			} catch {
				// Process already exited.
			}
		}
	}, 1000);

	let stderrTail = '';
	const readStderr = (async () => {
		for await (const line of streamLines(proc.stderr as ReadableStream<Uint8Array>)) {
			lastActivity = Date.now();
			const safe = redactSecrets(line, opts.secrets);
			stderrTail = (stderrTail + safe + '\n').slice(-12_000);
			if (opts.verbose) console.error(`[ffmpeg] ${safe}`);
		}
	})();

	const readStdout = (async () => {
		for await (const line of streamLines(proc.stdout as ReadableStream<Uint8Array>)) {
			lastActivity = Date.now();
			const eq = line.indexOf('=');
			if (eq < 0) continue;
			const key = line.slice(0, eq).trim();
			const value = line.slice(eq + 1).trim();
			let seconds: number | null = null;
			if (key === 'out_time_us' || key === 'out_time_ms') {
				const us = Number(value);
				if (Number.isFinite(us)) seconds = us / 1_000_000;
			} else if (key === 'out_time') {
				const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value);
				if (match) seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
			}
			if (seconds !== null && opts.durationSeconds > 0) {
				opts.onProgress?.(Math.min(100, (seconds / opts.durationSeconds) * 100));
			}
		}
	})();

	const exitCode = await proc.exited;
	clearInterval(watchdog);
	opts.signal?.removeEventListener('abort', abort);
	await Promise.allSettled([readStdout, readStderr]);
	activeFfmpeg = null;
	return { exitCode, stderrTail: stderrTail.trim(), killReason };
}

function baseArgs(opts: DownloadOptions): string[] {
	return [
		'-hide_banner',
		'-nostdin',
		'-loglevel',
		opts.verbose ? 'info' : 'error',
		'-nostats',
		'-progress',
		'pipe:1',
		...(opts.inputArgs ?? ['-rtsp_transport', 'tcp', '-i', opts.url]),
		'-t',
		String(opts.durationSeconds),
		'-map',
		'0:v:0',
		'-map',
		'0:a?'
	];
}

export async function runFfmpegDownload(opts: DownloadOptions): Promise<void> {
	const suffix = ['-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-y', opts.outputPath];
	const result = await spawnAttempt(['ffmpeg', ...baseArgs(opts), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '64k', ...suffix], opts);

	if (result.killReason) {
		throw new VideoExtractorError('RTSP_ERROR', result.killReason, result.stderrTail || undefined);
	}
	if (result.exitCode !== 0) {
		const { code, message } = classifyFfmpegError(result.stderrTail);
		throw new VideoExtractorError(code, message, result.stderrTail || undefined);
	}
}

export type ProbeResult = {
	sizeBytes: number;
	durationSeconds: number | null;
	hasVideo: boolean;
	videoCodec: string | null;
	width: number | null;
	height: number | null;
};

export async function probeFile(filePath: string): Promise<ProbeResult> {
	const proc = Bun.spawn(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath], {
		stdout: 'pipe',
		stderr: 'pipe',
		stdin: 'ignore'
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		throw new VideoExtractorError('VALIDATION_FAILED', 'ffprobe nao conseguiu ler o arquivo gerado.', stderr.trim() || undefined);
	}

	let json: {
		streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
		format?: { duration?: string; size?: string };
	};
	try {
		json = JSON.parse(stdout);
	} catch {
		throw new VideoExtractorError('VALIDATION_FAILED', 'ffprobe retornou saida invalida para o arquivo gerado.');
	}

	const streams = Array.isArray(json.streams) ? json.streams : [];
	const video = streams.find((stream) => stream.codec_type === 'video');
	const duration = Number(json.format?.duration);
	return {
		sizeBytes: Number(json.format?.size ?? 0) || 0,
		durationSeconds: Number.isFinite(duration) ? duration : null,
		hasVideo: Boolean(video),
		videoCodec: video?.codec_name ?? null,
		width: video?.width ?? null,
		height: video?.height ?? null
	};
}
