import { env } from '../config/env';

const SERVICE_VERSION = '2020-12-06';

export type BlobEntry = {
	name: string;
	size: number;
	lastModified: string;
	metadata: Record<string, string>;
};

export function azureStorageConfigured() {
	return Boolean(env.azure.accountName && env.azure.accountKey);
}

export async function listBlobs(container: string, prefix: string): Promise<BlobEntry[]> {
	const sas = await signServiceSas({
		resource: 'c',
		canonicalizedResource: `/blob/${env.azure.accountName}/${container}`,
		permissions: 'rl',
		ttlSeconds: 300
	});

	const url = new URL(`${accountUrl()}/${encodeURIComponent(container)}`);
	url.search = sas;
	url.searchParams.set('restype', 'container');
	url.searchParams.set('comp', 'list');
	url.searchParams.set('include', 'metadata');
	if (prefix) url.searchParams.set('prefix', prefix);

	const response = await fetch(url, { headers: { 'x-ms-version': SERVICE_VERSION } });
	const body = await response.text();
	if (!response.ok) {
		throw new Error(`Azure respondeu HTTP ${response.status} ao listar "${container}": ${body.slice(0, 300)}`);
	}

	return parseBlobList(body);
}

/** Short lived read link so the desktop app can download a build without the account key. */
export async function blobDownloadUrl(container: string, blobName: string, ttlSeconds: number) {
	const sas = await signServiceSas({
		resource: 'b',
		canonicalizedResource: `/blob/${env.azure.accountName}/${container}/${blobName}`,
		permissions: 'r',
		ttlSeconds
	});

	const url = new URL(`${accountUrl()}/${encodeURIComponent(container)}/${encodeBlobName(blobName)}`);
	url.search = sas;
	return url.toString();
}

/** Overwrites the blob if it already exists. Metadata keys must be valid Azure names (letters/digits). */
export async function uploadBlob(
	container: string,
	blobName: string,
	body: Uint8Array,
	options: { contentType?: string; metadata?: Record<string, string> } = {}
) {
	const sas = await signServiceSas({
		resource: 'b',
		canonicalizedResource: `/blob/${env.azure.accountName}/${container}/${blobName}`,
		permissions: 'cw',
		ttlSeconds: 30 * 60
	});

	const url = new URL(`${accountUrl()}/${encodeURIComponent(container)}/${encodeBlobName(blobName)}`);
	url.search = sas;

	const headers: Record<string, string> = {
		'x-ms-version': SERVICE_VERSION,
		'x-ms-blob-type': 'BlockBlob',
		'Content-Type': options.contentType ?? 'application/octet-stream'
	};
	for (const [key, value] of Object.entries(options.metadata ?? {})) {
		headers[`x-ms-meta-${key}`] = value;
	}

	const response = await fetch(url, {
		method: 'PUT',
		headers,
		body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
	});
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`Azure respondeu HTTP ${response.status} ao enviar "${blobName}": ${detail.slice(0, 300)}`);
	}
}

function accountUrl() {
	return `https://${env.azure.accountName}.blob.core.windows.net`;
}

function encodeBlobName(name: string) {
	return name.split('/').map(encodeURIComponent).join('/');
}

type SasInput = {
	resource: 'b' | 'c';
	canonicalizedResource: string;
	permissions: string;
	ttlSeconds: number;
};

async function signServiceSas({ resource, canonicalizedResource, permissions, ttlSeconds }: SasInput) {
	if (!azureStorageConfigured()) throw new Error('Azure Storage não está configurado.');

	// Clock skew between this server and Azure would reject a SAS that starts "now".
	const start = isoSeconds(new Date(Date.now() - 5 * 60_000));
	const expiry = isoSeconds(new Date(Date.now() + ttlSeconds * 1000));
	const stringToSign = [
		permissions,
		start,
		expiry,
		canonicalizedResource,
		'', // signed identifier
		'', // signed IP
		'https',
		SERVICE_VERSION,
		resource,
		'', // snapshot time
		'', // encryption scope
		'', // rscc
		'', // rscd
		'', // rsce
		'', // rscl
		'' // rsct
	].join('\n');

	const params = new URLSearchParams({
		sv: SERVICE_VERSION,
		st: start,
		se: expiry,
		sr: resource,
		sp: permissions,
		spr: 'https',
		sig: await hmacSha256Base64(env.azure.accountKey, stringToSign)
	});

	return params.toString();
}

async function hmacSha256Base64(base64Key: string, message: string) {
	const key = await crypto.subtle.importKey(
		'raw',
		Uint8Array.from(atob(base64Key), (char) => char.charCodeAt(0)),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
	return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

function isoSeconds(date: Date) {
	return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseBlobList(xml: string): BlobEntry[] {
	const entries: BlobEntry[] = [];

	for (const match of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
		const block = match[1] ?? '';
		const name = tagValue(block, 'Name');
		if (!name) continue;

		entries.push({
			name,
			size: Number(tagValue(block, 'Content-Length') ?? 0),
			lastModified: toIso(tagValue(block, 'Last-Modified')),
			metadata: parseMetadata(block)
		});
	}

	return entries;
}

function parseMetadata(block: string): Record<string, string> {
	const metadata: Record<string, string> = {};
	const section = /<Metadata>([\s\S]*?)<\/Metadata>/.exec(block)?.[1];
	if (!section) return metadata;

	for (const match of section.matchAll(/<([^/!?][^\s>]*)>([\s\S]*?)<\/\1>/g)) {
		const key = match[1];
		if (!key) continue;
		metadata[key.toLowerCase()] = decodeXml(match[2] ?? '');
	}
	return metadata;
}

function tagValue(block: string, tag: string) {
	const value = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)?.[1];
	return value === undefined ? null : decodeXml(value);
}

function toIso(value: string | null) {
	if (!value) return new Date(0).toISOString();
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

function decodeXml(value: string) {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}
