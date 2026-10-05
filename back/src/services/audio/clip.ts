import { ensureFfmpegTools } from '../video/ffmpeg';

export type AudioPart = 'FULL' | 'HEAD' | 'TAIL';

export type AudioWindow = {
	part: AudioPart;
	windowStart: Date;
	windowEnd: Date;
};

export type AudioChunk = {
	path: string;
	startedAt: Date;
	endedAt: Date;
};

export type AudioGap = {
	start: string;
	end: string;
	seconds: number;
};

export type AudioCoverage = {
	chunks: Array<AudioChunk & { offsetSeconds: number; durationSeconds: number }>;
	gaps: AudioGap[];
	coveredSeconds: number;
};

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

export function computeAudioParts(startedAt: Date, closedAt: Date | null, now: Date, clipMinutes: number): AudioWindow[] {
	const clipMs = clipMinutes * MINUTE_MS;
	if (clipMs <= 0) throw new Error('clipMinutes precisa ser positivo.');

	const startMs = startedAt.getTime();
	const closedMs = closedAt?.getTime() ?? null;
	if (closedMs !== null && closedMs <= startMs) return [];

	if (closedMs === null) {
		if (now.getTime() < startMs + clipMs) return [];
		return [{ part: 'HEAD', windowStart: new Date(startMs), windowEnd: new Date(startMs + clipMs) }];
	}

	const durationMs = closedMs - startMs;
	if (durationMs <= clipMs) {
		return [{ part: 'FULL', windowStart: new Date(startMs), windowEnd: new Date(closedMs) }];
	}

	const headEnd = startMs + clipMs;
	return [
		{ part: 'HEAD', windowStart: new Date(startMs), windowEnd: new Date(headEnd) },
		{
			part: 'TAIL',
			windowStart: new Date(Math.max(headEnd, closedMs - clipMs)),
			windowEnd: new Date(closedMs)
		}
	];
}

export function calculateAudioCoverage(windowStart: Date, windowEnd: Date, chunks: AudioChunk[]): AudioCoverage {
	const startMs = windowStart.getTime();
	const endMs = windowEnd.getTime();
	const selected = chunks
		.map((chunk) => {
			const chunkStart = chunk.startedAt.getTime();
			const chunkEnd = chunk.endedAt.getTime();
			const intersectionStart = Math.max(startMs, chunkStart);
			const intersectionEnd = Math.min(endMs, chunkEnd);
			if (intersectionEnd <= intersectionStart) return null;
			return {
				...chunk,
				startedAt: new Date(chunkStart),
				endedAt: new Date(chunkEnd),
				offsetSeconds: Math.max(0, (intersectionStart - chunkStart) / SECOND_MS),
				durationSeconds: Math.max(0.001, (intersectionEnd - intersectionStart) / SECOND_MS),
				intersectionStart,
				intersectionEnd
			};
		})
		.filter((chunk): chunk is NonNullable<typeof chunk> => Boolean(chunk))
		.sort((a, b) => a.intersectionStart - b.intersectionStart);

	const merged: Array<{ start: number; end: number }> = [];
	for (const chunk of selected) {
		const last = merged.at(-1);
		if (last && chunk.intersectionStart <= last.end + 250) {
			last.end = Math.max(last.end, chunk.intersectionEnd);
		} else {
			merged.push({ start: chunk.intersectionStart, end: chunk.intersectionEnd });
		}
	}

	const gaps: AudioGap[] = [];
	let cursor = startMs;
	for (const interval of merged) {
		if (interval.start > cursor + 250) gaps.push(toGap(cursor, interval.start));
		cursor = Math.max(cursor, interval.end);
	}
	if (cursor < endMs - 250) gaps.push(toGap(cursor, endMs));

	return {
		chunks: selected.map(({ intersectionStart, intersectionEnd, ...chunk }) => chunk),
		gaps,
		coveredSeconds: Math.round(merged.reduce((total, interval) => total + (interval.end - interval.start) / SECOND_MS, 0))
	};
}

function toGap(start: number, end: number): AudioGap {
	return {
		start: new Date(start).toISOString(),
		end: new Date(end).toISOString(),
		seconds: Math.round((end - start) / SECOND_MS)
	};
}

/** True when ffprobe finds a decodable audio stream; headerless or truncated blobs fail here. */
export async function isReadableAudioChunk(path: string): Promise<boolean> {
	const proc = Bun.spawn(
		['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path],
		{ stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' }
	);
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	return exitCode === 0 && stdout.includes('audio');
}

export class NoReadableAudioError extends Error {}

export async function renderAudioPart(input: {
	windowStart: Date;
	windowEnd: Date;
	chunks: AudioChunk[];
	outputPath: string;
}): Promise<AudioCoverage & { discardedChunks: number }> {
	await ensureFfmpegTools();

	const readability = await Promise.all(input.chunks.map((chunk) => isReadableAudioChunk(chunk.path)));
	const readable = input.chunks.filter((_, index) => readability[index]);
	const discardedChunks = input.chunks.length - readable.length;

	const coverage = calculateAudioCoverage(input.windowStart, input.windowEnd, readable);
	if (coverage.chunks.length === 0) {
		throw new NoReadableAudioError(
			discardedChunks > 0
				? 'Nenhum trecho de audio legivel cobre a janela solicitada.'
				: 'Nenhum trecho de audio cobre a janela solicitada.'
		);
	}

	const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats'];
	for (const chunk of coverage.chunks) {
		args.push('-ss', chunk.offsetSeconds.toFixed(3), '-t', chunk.durationSeconds.toFixed(3), '-i', chunk.path);
	}

	const labels = coverage.chunks.map((_, index) => `[${index}:a:0]`).join('');
	args.push(
		'-filter_complex',
		`${labels}concat=n=${coverage.chunks.length}:v=0:a=1[aout]`,
		'-map',
		'[aout]',
		'-ac',
		'1',
		'-c:a',
		'libopus',
		'-b:a',
		'32k',
		'-application',
		'voip',
		'-y',
		input.outputPath
	);

	const proc = Bun.spawn(['ffmpeg', ...args], { stdout: 'ignore', stderr: 'pipe', stdin: 'ignore' });
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Falha ao montar audio do atendimento com ffmpeg: ${stderr.trim().slice(-1000) || 'sem detalhes'}`);
	}

	return { ...coverage, discardedChunks };
}
