import { browser } from '$app/environment';
import { api } from '$lib/api/client';
import type { AudioConfig, User } from '$lib/types';
import {
	getDeviceLabel,
	getOrCreateDeviceId,
	getSelectedAudioInputDeviceId,
	listAudioInputDevices,
	saveChunk,
	setSelectedAudioInputDeviceId,
	type AudioInputDevice
} from './buffer';

const PREFERRED_MIME = 'audio/webm;codecs=opus';
const FALLBACK_MIME = 'audio/webm';
const AUDIO_BITS_PER_SECOND = 32_000;

type ActiveRecorder = {
	recorder: MediaRecorder;
	userId: string;
	deviceId: string;
	deviceLabel: string;
	startedAt: string;
	endedAt: string;
	mime: string;
};

export type AudioRecorderStatus =
	| 'idle'
	| 'starting'
	| 'recording'
	| 'stopping'
	| 'disabled'
	| 'unsupported'
	| 'error';

export const audioRecorderState = $state({
	recording: false,
	status: 'idle' as AudioRecorderStatus,
	message: '',
	error: '',
	deviceId: '',
	deviceLabel: '',
	config: null as AudioConfig | null,
	serverTimeOffsetMs: 0,
	devices: [] as AudioInputDevice[]
});

let mediaStream: MediaStream | null = null;
let currentRecorder: ActiveRecorder | null = null;
let activeUser: User | null = null;
let rotateTimer: ReturnType<typeof setTimeout> | null = null;
let activeRecorders: ActiveRecorder[] = [];
let startGeneration = 0;
let startingUserId: string | null = null;

export async function syncConfig() {
	if (!browser) return null;
	try {
		const config = await api<AudioConfig>('/api/audio/config');
		audioRecorderState.config = config;
		applyServerTime(config.serverTime);
		return config;
	} catch (error) {
		audioRecorderState.error = error instanceof Error ? error.message : 'Falha ao carregar audio.';
		audioRecorderState.message = 'Nao foi possivel carregar a configuracao de audio.';
		return null;
	}
}

export function applyServerTime(serverTime?: string | null) {
	if (!serverTime) return;
	const serverTimestamp = Date.parse(serverTime);
	if (Number.isFinite(serverTimestamp)) {
		audioRecorderState.serverTimeOffsetMs = serverTimestamp - Date.now();
	}
}

export async function start(user: User | null) {
	if (!browser || !user) {
		stop();
		return;
	}

	if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
		audioRecorderState.status = 'unsupported';
		audioRecorderState.recording = false;
		audioRecorderState.message = 'Este navegador nao suporta gravacao de audio.';
		return;
	}

	if (activeUser?.id === user.id && (mediaStream || startingUserId === user.id)) return;
	if (activeUser?.id && activeUser.id !== user.id) stop();

	const generation = ++startGeneration;
	const cancelled = () => generation !== startGeneration;
	activeUser = user;
	startingUserId = user.id;
	audioRecorderState.status = 'starting';
	audioRecorderState.message = 'Preparando microfone...';
	audioRecorderState.error = '';

	try {
		const config = await syncConfig();
		if (cancelled()) return;
		if (!config?.enabled) {
			audioRecorderState.status = 'disabled';
			audioRecorderState.recording = false;
			audioRecorderState.message = 'Captura de audio desativada.';
			return;
		}

		audioRecorderState.deviceId = getOrCreateDeviceId();
		audioRecorderState.deviceLabel = await getDeviceLabel();
		if (cancelled()) return;
		audioRecorderState.message = 'Aguardando permissão do microfone...';
		const stream = await openMediaStream();
		if (cancelled()) {
			stream.getTracks().forEach((track) => track.stop());
			return;
		}
		mediaStream = stream;
		startNewRecorder();
		audioRecorderState.recording = true;
		audioRecorderState.status = 'recording';
		audioRecorderState.message = 'Audio local ativo.';
		scheduleRotation();
	} catch (error) {
		if (cancelled()) return;
		stopMediaTracks();
		audioRecorderState.recording = false;
		audioRecorderState.status = 'error';
		if (error instanceof DOMException && error.name === 'NotAllowedError') {
			audioRecorderState.error =
				'Permissão do microfone negada. Libere no ícone de cadeado da barra de endereço e clique para tentar de novo.';
		} else {
			audioRecorderState.error = error instanceof Error ? error.message : 'Falha ao iniciar audio.';
		}
		audioRecorderState.message = 'Nao foi possivel acessar o microfone.';
	} finally {
		if (!cancelled()) startingUserId = null;
	}
}

export async function retry() {
	const user = activeUser;
	if (!user || audioRecorderState.recording) return;
	await start(user);
}

export function stop() {
	if (!browser) return;
	startGeneration += 1;
	startingUserId = null;
	clearRotation();

	if (!audioRecorderState.recording && !mediaStream && activeRecorders.length === 0) {
		activeUser = null;
		if (audioRecorderState.status === 'starting') {
			audioRecorderState.status = 'idle';
			audioRecorderState.message = 'Audio parado.';
		}
		return;
	}

	audioRecorderState.status = 'stopping';
	audioRecorderState.recording = false;
	for (const recorder of [...activeRecorders]) {
		stopRecorder(recorder);
	}
	currentRecorder = null;
	stopMediaTracks();
	activeUser = null;
	audioRecorderState.status = 'idle';
	audioRecorderState.message = 'Audio parado.';
}

export async function setDevice(deviceId: string) {
	const selected = audioRecorderState.devices.find((device) => device.deviceId === deviceId);
	setSelectedAudioInputDeviceId(deviceId, selected?.label ?? '');
	audioRecorderState.deviceLabel = selected?.label || (await getDeviceLabel());

	const user = activeUser;
	if (user) {
		stop();
		await start(user);
	}
}

export async function loadDevices() {
	try {
		const devices = await listAudioInputDevices();
		audioRecorderState.devices = devices;
		if (!audioRecorderState.deviceLabel) audioRecorderState.deviceLabel = await getDeviceLabel();
		return devices;
	} catch (error) {
		audioRecorderState.error = error instanceof Error ? error.message : 'Falha ao listar microfones.';
		return [];
	}
}

function startNewRecorder() {
	if (!mediaStream || !activeUser) throw new Error('Microfone nao iniciado.');
	const mimeType = supportedMimeType();
	const recorder = new MediaRecorder(mediaStream, {
		audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
		...(mimeType ? { mimeType } : {})
	});

	const active: ActiveRecorder = {
		recorder,
		userId: activeUser.id,
		deviceId: audioRecorderState.deviceId,
		deviceLabel: audioRecorderState.deviceLabel,
		startedAt: serverNowIso(),
		endedAt: '',
		mime: recorder.mimeType || mimeType || FALLBACK_MIME
	};

	activeRecorders = [...activeRecorders, active];
	currentRecorder = active;

	recorder.ondataavailable = (event) => {
		if (!event.data?.size) return;
		void saveChunk({
			userId: active.userId,
			deviceId: active.deviceId,
			deviceLabel: active.deviceLabel,
			startedAt: active.startedAt,
			endedAt: active.endedAt || serverNowIso(),
			mime: event.data.type || active.mime,
			blob: event.data
		});
	};

	recorder.onerror = (event) => {
		audioRecorderState.status = 'error';
		audioRecorderState.error = event.error?.message ?? 'Erro no gravador de audio.';
		audioRecorderState.message = 'A gravacao de audio falhou.';
	};

	recorder.onstop = () => {
		activeRecorders = activeRecorders.filter((recorderState) => recorderState !== active);
	};

	recorder.start();
	return active;
}

function rotateRecorder() {
	if (!audioRecorderState.recording || !mediaStream || !activeUser) return;
	const previous = currentRecorder;
	try {
		startNewRecorder();
		if (previous) stopRecorder(previous);
	} catch (error) {
		audioRecorderState.error = error instanceof Error ? error.message : 'Falha ao rotacionar audio.';
	}
	scheduleRotation();
}

function stopRecorder(active: ActiveRecorder) {
	if (active.recorder.state === 'inactive') return;
	active.endedAt = serverNowIso();
	// The recorder runs without a timeslice, so stop() flushes a single self-contained
	// WebM blob. Calling requestData() first would split it into a headed blob plus a
	// headerless continuation that ffmpeg cannot open.
	try {
		active.recorder.stop();
	} catch {
		activeRecorders = activeRecorders.filter((recorderState) => recorderState !== active);
	}
}

function scheduleRotation() {
	clearRotation();
	const seconds = Math.max(5, audioRecorderState.config?.chunkSeconds ?? 30);
	rotateTimer = setTimeout(rotateRecorder, seconds * 1_000);
}

function clearRotation() {
	if (!rotateTimer) return;
	clearTimeout(rotateTimer);
	rotateTimer = null;
}

async function openMediaStream() {
	try {
		return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(true) });
	} catch (error) {
		if (!getSelectedAudioInputDeviceId()) throw error;
		return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(false) });
	}
}

function audioConstraints(includeSelectedDevice: boolean): MediaTrackConstraints {
	const constraints: MediaTrackConstraints = {
		channelCount: 1,
		echoCancellation: true,
		noiseSuppression: true,
		autoGainControl: true
	};
	const selectedDeviceId = getSelectedAudioInputDeviceId();
	if (includeSelectedDevice && selectedDeviceId) constraints.deviceId = { exact: selectedDeviceId };
	return constraints;
}

function supportedMimeType() {
	if (MediaRecorder.isTypeSupported?.(PREFERRED_MIME)) return PREFERRED_MIME;
	if (MediaRecorder.isTypeSupported?.(FALLBACK_MIME)) return FALLBACK_MIME;
	return '';
}

function stopMediaTracks() {
	mediaStream?.getTracks().forEach((track) => track.stop());
	mediaStream = null;
}

function serverNowIso() {
	return new Date(Date.now() + audioRecorderState.serverTimeOffsetMs).toISOString();
}
