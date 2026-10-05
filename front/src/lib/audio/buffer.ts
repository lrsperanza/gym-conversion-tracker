import { browser } from '$app/environment';

const DB_NAME = 'skyfit-audio';
const DB_VERSION = 1;
const CHUNKS_STORE = 'chunks';
const DEVICE_ID_KEY = 'skyfit:audio-device-id';
const AUDIO_INPUT_KEY = 'skyfit:audio-device';
const AUDIO_INPUT_LABEL_KEY = 'skyfit:audio-device-label';

export type AudioInputDevice = {
	deviceId: string;
	label: string;
};

export type AudioChunkRecord = {
	id: string;
	userId: string;
	deviceId: string;
	deviceLabel?: string;
	startedAt: string;
	endedAt: string;
	mime?: string;
	blob: Blob;
	createdAt: string;
};

export type SaveChunkInput = Omit<AudioChunkRecord, 'id' | 'createdAt'>;

export type ReadChunksWindow = {
	userId: string;
	deviceId: string;
	start: string;
	end: string;
};

let dbPromise: Promise<IDBDatabase> | null = null;

export function getOrCreateDeviceId() {
	if (!browser) return 'browser-unavailable';
	const existing = localStorage.getItem(DEVICE_ID_KEY);
	if (existing) return existing;

	const id = crypto.randomUUID?.() ?? `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	localStorage.setItem(DEVICE_ID_KEY, id);
	return id;
}

export function getSelectedAudioInputDeviceId() {
	if (!browser) return '';
	return localStorage.getItem(AUDIO_INPUT_KEY) ?? '';
}

export function setSelectedAudioInputDeviceId(deviceId: string, label = '') {
	if (!browser) return;
	if (deviceId) {
		localStorage.setItem(AUDIO_INPUT_KEY, deviceId);
	} else {
		localStorage.removeItem(AUDIO_INPUT_KEY);
	}
	if (label) localStorage.setItem(AUDIO_INPUT_LABEL_KEY, label);
}

export async function getDeviceLabel() {
	if (!browser) return '';
	const savedLabel = localStorage.getItem(AUDIO_INPUT_LABEL_KEY) ?? '';
	const selectedDeviceId = getSelectedAudioInputDeviceId();
	if (!navigator.mediaDevices?.enumerateDevices) return savedLabel || 'Microfone do dispositivo';

	const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
	const selected = devices.find(
		(device) => device.kind === 'audioinput' && device.deviceId === selectedDeviceId
	);
	const label = selected?.label || savedLabel || 'Microfone do dispositivo';
	if (selectedDeviceId && selected?.label) localStorage.setItem(AUDIO_INPUT_LABEL_KEY, selected.label);
	return label;
}

export async function saveChunk(input: SaveChunkInput) {
	if (!browser || !input.blob.size) return;
	if (Date.parse(input.endedAt) <= Date.parse(input.startedAt)) return;
	const db = await openDb();
	const record: AudioChunkRecord = {
		...input,
		id: `${input.userId}:${input.deviceId}:${input.startedAt}:${crypto.randomUUID?.() ?? Math.random()}`,
		mime: input.mime || input.blob.type || 'audio/webm',
		createdAt: new Date().toISOString()
	};

	await requestToPromise(
		db.transaction(CHUNKS_STORE, 'readwrite').objectStore(CHUNKS_STORE).put(record)
	);
}

export async function readChunksForWindow(window: ReadChunksWindow) {
	if (!browser) return [];
	const db = await openDb();
	const startTime = Date.parse(window.start);
	const endTime = Date.parse(window.end);
	if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) return [];

	const tx = db.transaction(CHUNKS_STORE, 'readonly');
	const index = tx.objectStore(CHUNKS_STORE).index('startedAt');
	const chunks: AudioChunkRecord[] = [];

	await cursorPromise(index.openCursor(IDBKeyRange.upperBound(window.end)), (cursor) => {
		const record = cursor.value as AudioChunkRecord;
		const recordEnd = Date.parse(record.endedAt);
		if (
			record.userId === window.userId &&
			record.deviceId === window.deviceId &&
			Number.isFinite(recordEnd) &&
			recordEnd >= startTime &&
			recordEnd > Date.parse(record.startedAt) &&
			record.blob.size > 0
		) {
			chunks.push(record);
		}
	});

	return chunks.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

export async function pruneChunks(bufferMinutes: number) {
	const minutes = Number.isFinite(bufferMinutes) && bufferMinutes > 0 ? bufferMinutes : 240;
	const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();
	await deleteOldChunks(cutoff);
}

export async function deleteOldChunks(cutoffIso: string) {
	if (!browser) return;
	const cutoffTime = Date.parse(cutoffIso);
	if (!Number.isFinite(cutoffTime)) return;

	const db = await openDb();
	const tx = db.transaction(CHUNKS_STORE, 'readwrite');
	const index = tx.objectStore(CHUNKS_STORE).index('startedAt');

	await cursorPromise(index.openCursor(IDBKeyRange.upperBound(cutoffIso)), (cursor) => {
		const record = cursor.value as AudioChunkRecord;
		const endedAt = Date.parse(record.endedAt);
		if (Number.isFinite(endedAt) && endedAt < cutoffTime) cursor.delete();
	});

	await transactionDone(tx);
}

export async function listAudioInputDevices(): Promise<AudioInputDevice[]> {
	if (!browser || !navigator.mediaDevices?.enumerateDevices) return [];

	let devices = await navigator.mediaDevices.enumerateDevices();
	const needsLabels =
		devices.some((device) => device.kind === 'audioinput') &&
		devices.every((device) => device.kind !== 'audioinput' || !device.label);

	if (needsLabels && navigator.mediaDevices.getUserMedia) {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
		stream?.getTracks().forEach((track) => track.stop());
		devices = await navigator.mediaDevices.enumerateDevices().catch(() => devices);
	}

	const selectedDeviceId = getSelectedAudioInputDeviceId();
	return devices
		.filter((device) => device.kind === 'audioinput')
		.map((device, index) => {
			const label = device.label || `Microfone ${index + 1}`;
			if (device.deviceId === selectedDeviceId && device.label) {
				localStorage.setItem(AUDIO_INPUT_LABEL_KEY, device.label);
			}
			return { deviceId: device.deviceId, label };
		});
}

function openDb() {
	if (!browser || !indexedDB) return Promise.reject(new Error('IndexedDB indisponivel neste navegador.'));
	if (dbPromise) return dbPromise;

	dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);

		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
				const store = db.createObjectStore(CHUNKS_STORE, { keyPath: 'id' });
				store.createIndex('startedAt', 'startedAt');
				store.createIndex('userId', 'userId');
				store.createIndex('deviceId', 'deviceId');
				store.createIndex('userDeviceStartedAt', ['userId', 'deviceId', 'startedAt']);
			}
		};

		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('Falha ao abrir o buffer de audio.'));
	});

	return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>) {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('Operacao IndexedDB falhou.'));
	});
}

function cursorPromise(
	request: IDBRequest<IDBCursorWithValue | null>,
	onValue: (cursor: IDBCursorWithValue) => void
) {
	return new Promise<void>((resolve, reject) => {
		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) {
				resolve();
				return;
			}
			onValue(cursor);
			cursor.continue();
		};
		request.onerror = () => reject(request.error ?? new Error('Falha ao ler o buffer de audio.'));
	});
}

function transactionDone(tx: IDBTransaction) {
	return new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error('Transacao IndexedDB falhou.'));
		tx.onabort = () => reject(tx.error ?? new Error('Transacao IndexedDB cancelada.'));
	});
}
