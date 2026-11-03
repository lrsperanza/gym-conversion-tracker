import { browser } from '$app/environment';
import { api } from '$lib/api/client';
import { resolveApiHostUrl } from '$lib/api/hosts';
import type { AudioConfig, User } from '$lib/types';
import {
	countPendingSegments,
	deleteSegment,
	enqueueSegment,
	getOrCreateDeviceId,
	listPendingSegments,
	markAttempt,
	type PendingSegment
} from './queue';

/**
 * Gravação contínua do microfone, em trechos autocontidos de `segmentSeconds` (60s por padrão),
 * alinhados ao relógio (hh:mm:00) para facilitar a busca por horário na auditoria.
 *
 * Cada trecho é um MediaRecorder próprio sobre o mesmo stream: na virada, o próximo começa antes de
 * o anterior parar, então não há buraco entre arquivos (há alguns ms de sobreposição, que o player
 * descarta). Os trechos vão para a fila do IndexedDB e sobem para `POST /api/audio/segments`.
 */

const PREFERRED_MIME = 'audio/webm;codecs=opus';
const FALLBACK_MIME = 'audio/webm';
const AUDIO_BITS_PER_SECOND = 32_000;
const UPLOAD_INTERVAL_MS = 30_000;
const MAX_UPLOAD_ATTEMPTS = 20;
/** Um 4xx pode ser bug do back; dá tempo de corrigir antes de descartar áudio gravado. */
const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;
const DRAFT_KEY = 'attendance-quick-draft';

export type AudioRecorderStatus =
	'idle' | 'starting' | 'recording' | 'disabled' | 'unsupported' | 'error';

export const audioRecorderState = $state({
	status: 'idle' as AudioRecorderStatus,
	error: '',
	deviceLabel: '',
	pending: 0,
	lastUploadAt: '',
	uploadError: ''
});

type ActiveSegment = {
	recorder: MediaRecorder;
	startedAt: string;
	endedAt: string;
};

let user: User | null = null;
let config: AudioConfig | null = null;
let serverOffsetMs = 0;
let stream: MediaStream | null = null;
let current: ActiveSegment | null = null;
let rotateTimer: ReturnType<typeof setTimeout> | null = null;
let uploadTimer: ReturnType<typeof setInterval> | null = null;
let generation = 0;
let uploading = false;
let uploadQueued = false;

export async function start(nextUser: User) {
	if (!browser) return;
	if (user?.id === nextUser.id && (stream || audioRecorderState.status === 'starting')) return;
	stop();

	const run = ++generation;
	const cancelled = () => run !== generation;
	user = nextUser;
	audioRecorderState.status = 'starting';
	audioRecorderState.error = '';

	// Sobe o que ficou na fila de uma execução anterior mesmo se o microfone falhar agora.
	startUploader();

	if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
		audioRecorderState.status = 'unsupported';
		audioRecorderState.error = 'Este navegador não suporta gravação de áudio.';
		return;
	}

	try {
		config = await api<AudioConfig>('/api/audio/config');
		applyServerTime(config.serverTime);
		if (cancelled()) return;
		if (!config.enabled) {
			audioRecorderState.status = 'disabled';
			return;
		}

		const opened = await navigator.mediaDevices.getUserMedia({
			audio: {
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true
			}
		});
		if (cancelled()) {
			opened.getTracks().forEach((track) => track.stop());
			return;
		}
		stream = opened;
		const track = opened.getAudioTracks()[0];
		audioRecorderState.deviceLabel = track?.label || 'Microfone padrão';
		// Microfone desconectado: tenta reabrir (cai no padrão do Windows).
		track?.addEventListener('ended', () => {
			if (run !== generation || !user) return;
			const restartUser = user;
			stop();
			void start(restartUser);
		});

		current = startSegment();
		scheduleRotation();
		audioRecorderState.status = 'recording';
	} catch (error) {
		if (cancelled()) return;
		releaseStream();
		audioRecorderState.status = 'error';
		audioRecorderState.error =
			error instanceof DOMException && error.name === 'NotAllowedError'
				? 'Permissão do microfone negada.'
				: error instanceof Error
					? error.message
					: 'Falha ao iniciar o microfone.';
	}
}

export async function retry() {
	if (user) await start(user);
}

/** Para a gravação; o trecho em andamento é fechado e entra na fila normalmente. */
export function stop() {
	generation += 1;
	clearRotation();
	if (current) finishSegment(current);
	current = null;
	releaseStream();
	if (uploadTimer) clearInterval(uploadTimer);
	uploadTimer = null;
	if (audioRecorderState.status !== 'unsupported') audioRecorderState.status = 'idle';
}

function startSegment(): ActiveSegment {
	if (!stream) throw new Error('Microfone não iniciado.');
	const mimeType = MediaRecorder.isTypeSupported(PREFERRED_MIME)
		? PREFERRED_MIME
		: MediaRecorder.isTypeSupported(FALLBACK_MIME)
			? FALLBACK_MIME
			: '';
	const recorder = new MediaRecorder(stream, {
		audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
		...(mimeType ? { mimeType } : {})
	});
	const segment: ActiveSegment = { recorder, startedAt: serverNowIso(), endedAt: '' };
	const owner = user;
	const academyId = currentAcademyId();

	recorder.ondataavailable = (event) => {
		if (!owner || !event.data?.size) return;
		void enqueueSegment({
			userId: owner.id,
			deviceId: getOrCreateDeviceId(),
			deviceLabel: audioRecorderState.deviceLabel,
			academyId,
			startedAt: segment.startedAt,
			endedAt: segment.endedAt || serverNowIso(),
			mime: event.data.type || recorder.mimeType || FALLBACK_MIME,
			blob: event.data
		})
			.then(() => runUploader())
			.catch((error) => {
				audioRecorderState.uploadError =
					error instanceof Error ? error.message : 'Falha ao guardar o áudio.';
			});
	};
	recorder.onerror = () => {
		audioRecorderState.error = 'Erro no gravador de áudio.';
	};
	// Sem timeslice: stop() entrega um único blob WebM com cabeçalho, tocável sozinho.
	recorder.start();
	return segment;
}

function finishSegment(segment: ActiveSegment) {
	if (segment.recorder.state === 'inactive') return;
	segment.endedAt = serverNowIso();
	try {
		segment.recorder.stop();
	} catch {
		/* Already stopped by the browser (track ended). */
	}
}

function rotate() {
	if (!stream || !current) return;
	const previous = current;
	try {
		current = startSegment();
	} catch (error) {
		audioRecorderState.error = error instanceof Error ? error.message : 'Falha ao virar o trecho.';
	}
	finishSegment(previous);
	scheduleRotation();
}

/** Next boundary of the server clock, so segments start at hh:mm:00 (for 60s segments). */
function scheduleRotation() {
	clearRotation();
	const segmentMs = (config?.segmentSeconds ?? 60) * 1_000;
	const now = Date.now() + serverOffsetMs;
	let wait = segmentMs - (now % segmentMs);
	// A segment that just started would be only a few seconds long; extend it to the next boundary.
	if (wait < 5_000) wait += segmentMs;
	rotateTimer = setTimeout(rotate, wait);
}

function clearRotation() {
	if (rotateTimer) clearTimeout(rotateTimer);
	rotateTimer = null;
}

function releaseStream() {
	stream?.getTracks().forEach((track) => track.stop());
	stream = null;
}

function startUploader() {
	if (!uploadTimer) uploadTimer = setInterval(() => void runUploader(), UPLOAD_INTERVAL_MS);
	void runUploader();
}

async function runUploader() {
	if (uploading) {
		uploadQueued = true;
		return;
	}
	uploading = true;
	try {
		do {
			uploadQueued = false;
			const batch = await listPendingSegments(20);
			for (const segment of batch) {
				if (!(await uploadSegment(segment))) return;
			}
			if (batch.length === 20) uploadQueued = true;
		} while (uploadQueued);
	} catch (error) {
		audioRecorderState.uploadError =
			error instanceof Error ? error.message : 'Falha ao enviar áudio.';
	} finally {
		uploading = false;
		audioRecorderState.pending = await countPendingSegments().catch(
			() => audioRecorderState.pending
		);
	}
}

/** Returns false when the network or the server is down, so the rest of the queue waits. */
async function uploadSegment(segment: PendingSegment) {
	const form = new FormData();
	form.append('file', segment.blob, `segment.${segment.mime.includes('ogg') ? 'ogg' : 'webm'}`);
	form.append('deviceId', segment.deviceId);
	form.append('deviceLabel', segment.deviceLabel);
	if (segment.academyId) form.append('academyId', segment.academyId);
	form.append('startedAt', segment.startedAt);
	form.append('endedAt', segment.endedAt);

	let response: Response;
	try {
		response = await fetch(`${await resolveApiHostUrl()}/api/audio/segments`, {
			method: 'POST',
			credentials: 'include',
			body: form
		});
	} catch {
		audioRecorderState.uploadError = 'Sem conexão; o áudio fica guardado e sobe depois.';
		return false;
	}

	if (response.ok) {
		await deleteSegment(segment.id);
		const payload = await response.json().catch(() => null);
		applyServerTime(payload?.serverTime);
		audioRecorderState.lastUploadAt = new Date().toISOString();
		audioRecorderState.uploadError = '';
		return true;
	}

	const payload = await response.json().catch(() => null);
	audioRecorderState.uploadError =
		payload?.error?.message || `Falha ao enviar áudio (HTTP ${response.status}).`;
	// 401: sessão caiu; o trecho espera o próximo login. 5xx/429: tenta de novo depois.
	if (response.status === 401 || response.status === 429 || response.status >= 500) return false;
	// Outros 4xx não mudam com nova tentativa; só desiste de um trecho velho que falhou muitas vezes.
	const age = Date.now() - Date.parse(segment.startedAt);
	if (segment.attempts + 1 >= MAX_UPLOAD_ATTEMPTS && age > GIVE_UP_AFTER_MS) {
		await deleteSegment(segment.id);
	} else {
		await markAttempt(segment);
	}
	return true;
}

/** A academia selecionada na tela de atendimento; o back cai na academia do usuário se vier vazio. */
function currentAcademyId() {
	try {
		const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as {
			academyId?: string;
		} | null;
		return draft?.academyId ?? '';
	} catch {
		return '';
	}
}

function applyServerTime(serverTime?: string | null) {
	const parsed = serverTime ? Date.parse(serverTime) : NaN;
	if (Number.isFinite(parsed)) serverOffsetMs = parsed - Date.now();
}

function serverNowIso() {
	return new Date(Date.now() + serverOffsetMs).toISOString();
}
