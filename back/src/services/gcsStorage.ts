import { env } from '../config/env';

const API_URL = 'https://storage.googleapis.com';

export type BlobEntry = {
	name: string;
	size: number;
	lastModified: string;
	metadata: Record<string, string>;
};

type ObjectResource = {
	name?: string;
	size?: string;
	updated?: string;
	metadata?: Record<string, string>;
};

export function gcsStorageConfigured() {
	return Boolean(env.desktop.bucket);
}

/** The bucket grants public read (allUsers objectViewer), so listing needs no credentials. */
export async function listBlobs(bucket: string, prefix: string): Promise<BlobEntry[]> {
	const entries: BlobEntry[] = [];
	let pageToken: string | undefined;

	do {
		const url = new URL(`${API_URL}/storage/v1/b/${encodeURIComponent(bucket)}/o`);
		url.searchParams.set('fields', 'items(name,size,updated,metadata),nextPageToken');
		if (prefix) url.searchParams.set('prefix', prefix);
		if (pageToken) url.searchParams.set('pageToken', pageToken);

		const response = await fetch(url);
		if (!response.ok) {
			const body = await response.text();
			throw new Error(`GCS respondeu HTTP ${response.status} ao listar "${bucket}": ${body.slice(0, 300)}`);
		}

		const page = (await response.json()) as { items?: ObjectResource[]; nextPageToken?: string };
		for (const item of page.items ?? []) {
			if (!item.name) continue;
			entries.push({
				name: item.name,
				size: Number(item.size ?? 0),
				lastModified: toIso(item.updated),
				metadata: Object.fromEntries(
					Object.entries(item.metadata ?? {}).map(([key, value]) => [key.toLowerCase(), value])
				)
			});
		}
		pageToken = page.nextPageToken;
	} while (pageToken);

	return entries;
}

/** Objects are public, so the link never expires. */
export function blobDownloadUrl(bucket: string, objectName: string) {
	return `${API_URL}/${encodeURIComponent(bucket)}/${encodeObjectName(objectName)}`;
}

/**
 * Overwrites the object if it already exists. `no-cache` keeps a republished version from being
 * served stale by Google's edge cache, which would fail the sha256 check on the desktop.
 */
export async function uploadBlob(
	bucket: string,
	objectName: string,
	body: Uint8Array,
	options: {
		accessToken: string;
		contentType?: string;
		cacheControl?: string;
		metadata?: Record<string, string>;
	}
) {
	const contentType = options.contentType ?? 'application/octet-stream';
	const boundary = `skyfit-${crypto.randomUUID()}`;
	const resource = JSON.stringify({
		name: objectName,
		contentType,
		cacheControl: options.cacheControl ?? 'no-cache',
		metadata: options.metadata ?? {}
	});

	const encoder = new TextEncoder();
	const multipart = new Blob([
		encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${resource}\r\n`),
		encoder.encode(`--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
		body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
		encoder.encode(`\r\n--${boundary}--\r\n`)
	]);

	const url = new URL(`${API_URL}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`);
	url.searchParams.set('uploadType', 'multipart');

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${options.accessToken}`,
			'Content-Type': `multipart/related; boundary=${boundary}`
		},
		body: multipart
	});
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`GCS respondeu HTTP ${response.status} ao enviar "${objectName}" para ${bucket}: ${detail.slice(0, 300)}`);
	}
}

/** Authenticated media download, for private buckets. The caller streams the body onwards. */
export async function downloadBlob(bucket: string, objectName: string, accessToken: string) {
	const url = new URL(`${API_URL}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`);
	url.searchParams.set('alt', 'media');
	const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`GCS respondeu HTTP ${response.status} ao ler "${objectName}" de ${bucket}: ${detail.slice(0, 300)}`);
	}
	return response;
}

function encodeObjectName(name: string) {
	return name.split('/').map(encodeURIComponent).join('/');
}

function toIso(value: string | undefined) {
	if (!value) return new Date(0).toISOString();
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}
