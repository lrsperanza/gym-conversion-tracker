import { browser } from '$app/environment';
import { api } from '$lib/api/client';
import { resolveApiHostUrl } from '$lib/api/hosts';
import type { AudioPendingPart } from '$lib/types';
import {
	getDeviceLabel,
	getOrCreateDeviceId,
	pruneChunks,
	readChunksForWindow,
	type AudioChunkRecord
} from './buffer';
import { applyServerTime, audioRecorderState } from './recorder.svelte';

const POLL_INTERVAL_MS = 30_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let activeUserId = '';
let inFlight = false;
let queuedRun = false;
// Windows the server refused as unreadable from this device; retrying would send the
// same bytes again. Reset on reload, which costs at most one more rejected upload.
const unreadableWindows = new Set<string>();

type PendingAudioResponse = {
	parts: AudioPendingPart[];
	serverTime: string;
};

export function startAudioUploader(userId: string) {
	if (!browser || !userId) return;
	activeUserId = userId;
	if (!pollTimer) {
		pollTimer = setInterval(() => {
			void runUploader();
		}, POLL_INTERVAL_MS);
	}
	void runUploader();
}

export function stopAudioUploader() {
	activeUserId = '';
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
	queuedRun = false;
}

export function nudgeAudioUploader() {
	if (!browser || !activeUserId) return;
	void runUploader();
}

async function runUploader() {
	if (!activeUserId) return;
	if (inFlight) {
		queuedRun = true;
		return;
	}

	inFlight = true;
	queuedRun = false;
	const userId = activeUserId;

	try {
		const deviceId = getOrCreateDeviceId();
		const data = await api<PendingAudioResponse>(
			`/api/audio/pending?deviceId=${encodeURIComponent(deviceId)}`
		);
		applyServerTime(data.serverTime);

		const deviceLabel = await getDeviceLabel();
		let uploaded = 0;
		for (const part of data.parts) {
			if (userId !== activeUserId) return;
			if (unreadableWindows.has(windowKey(part))) continue;
			const chunks = await readChunksForWindow({
				userId,
				deviceId,
				start: part.windowStart,
				end: part.windowEnd
			});
			if (!chunks.length) continue;
			await uploadPart(part, chunks, deviceId, deviceLabel);
			uploaded += 1;
		}

		await pruneChunks(audioRecorderState.config?.bufferMinutes ?? 240);
		if (uploaded > 0) {
			audioRecorderState.message = `${uploaded} trecho${uploaded === 1 ? '' : 's'} de audio enviado${uploaded === 1 ? '' : 's'}.`;
		}
	} catch (error) {
		audioRecorderState.error = error instanceof Error ? error.message : 'Falha ao enviar audio.';
	} finally {
		inFlight = false;
		if (queuedRun) void runUploader();
	}
}

async function uploadPart(
	part: AudioPendingPart,
	chunks: AudioChunkRecord[],
	deviceId: string,
	deviceLabel: string
) {
	const formData = new FormData();
	formData.append(
		'meta',
		JSON.stringify({
			part: part.part,
			deviceId,
			deviceLabel,
			chunks: chunks.map((chunk) => ({
				startedAt: chunk.startedAt,
				endedAt: chunk.endedAt,
				mime: chunk.mime
			}))
		})
	);

	for (const [index, chunk] of chunks.entries()) {
		formData.append(
			'chunks',
			chunk.blob,
			`audio-${part.attendanceId}-${part.part.toLowerCase()}-${index + 1}.webm`
		);
	}

	const response = await fetch(`${await resolveApiHostUrl()}/api/attendances/${part.attendanceId}/audio`, {
		method: 'POST',
		credentials: 'include',
		body: formData
	});

	if (response.ok || response.status === 409) return;

	const payload = await response.json().catch(() => null);
	if (response.status === 422 && payload?.error?.code === 'AUDIO_UNREADABLE') {
		unreadableWindows.add(windowKey(part));
		return;
	}
	throw new Error(payload?.error?.message || 'Nao foi possivel enviar o audio.');
}

function windowKey(part: AudioPendingPart) {
	return `${part.attendanceId}:${part.part}:${part.windowStart}:${part.windowEnd}`;
}
