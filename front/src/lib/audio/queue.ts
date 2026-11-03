import { browser } from '$app/environment';

/**
 * Fila local (IndexedDB) dos trechos gravados que ainda não subiram. O trecho só sai daqui depois que
 * o back confirma o upload, então uma queda de internet ou um fechamento do app não perde áudio já
 * gravado: o uploader retoma no próximo start.
 */

const DB_NAME = 'skyfit-audio-segments';
const DB_VERSION = 1;
const STORE = 'pending';
const DEVICE_ID_KEY = 'skyfit:audio-device-id';

export type PendingSegment = {
	id: string;
	userId: string;
	deviceId: string;
	deviceLabel: string;
	academyId: string;
	startedAt: string;
	endedAt: string;
	mime: string;
	blob: Blob;
	attempts: number;
};

let dbPromise: Promise<IDBDatabase> | null = null;

export function getOrCreateDeviceId() {
	const existing = localStorage.getItem(DEVICE_ID_KEY);
	if (existing && /^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing;
	const id = crypto.randomUUID();
	localStorage.setItem(DEVICE_ID_KEY, id);
	return id;
}

export async function enqueueSegment(segment: Omit<PendingSegment, 'id' | 'attempts'>) {
	const record: PendingSegment = {
		...segment,
		id: `${segment.startedAt}:${segment.deviceId}`,
		attempts: 0
	};
	const db = await openDb();
	await requestDone(db.transaction(STORE, 'readwrite').objectStore(STORE).put(record));
}

/** Oldest first, so the timeline fills in order after an outage. */
export async function listPendingSegments(limit = 50): Promise<PendingSegment[]> {
	const db = await openDb();
	const store = db.transaction(STORE, 'readonly').objectStore(STORE);
	const records = await requestDone(store.index('startedAt').getAll(null, limit));
	return records as PendingSegment[];
}

export async function countPendingSegments() {
	const db = await openDb();
	return requestDone(db.transaction(STORE, 'readonly').objectStore(STORE).count());
}

export async function deleteSegment(id: string) {
	const db = await openDb();
	await requestDone(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
}

export async function markAttempt(segment: PendingSegment) {
	const db = await openDb();
	await requestDone(
		db
			.transaction(STORE, 'readwrite')
			.objectStore(STORE)
			.put({ ...segment, attempts: segment.attempts + 1 })
	);
}

function openDb() {
	if (!browser || !indexedDB) {
		return Promise.reject(new Error('IndexedDB indisponível neste navegador.'));
	}
	dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const store = request.result.createObjectStore(STORE, { keyPath: 'id' });
			store.createIndex('startedAt', 'startedAt');
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => {
			dbPromise = null;
			reject(request.error ?? new Error('Falha ao abrir a fila de áudio.'));
		};
	});
	return dbPromise;
}

function requestDone<T>(request: IDBRequest<T>) {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('Operação IndexedDB falhou.'));
	});
}
