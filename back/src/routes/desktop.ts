import { Hono } from 'hono';
import { env } from '../config/env';
import { blobDownloadUrl, gcsStorageConfigured, listBlobs, type BlobEntry } from '../services/gcsStorage';
import type { AppBindings } from '../http/types';

export const desktopRoutes = new Hono<AppBindings>();

const LISTING_TTL_MS = 60_000;

export type DesktopBuild = {
	version: string;
	fileName: string;
	size: number;
	publishedAt: string;
	sha256: string | null;
};

type Listing = { builds: DesktopBuild[]; fetchedAt: number };

let cachedListing: Listing | null = null;
let pendingListing: Promise<Listing> | null = null;

// The desktop app checks for updates before anyone logs in, so this stays public.
// It only ever exposes the public link to the installer that every user already runs.
desktopRoutes.get('/latest', async (c) => {
	if (!gcsStorageConfigured()) {
		return c.json({ configured: false, latest: null });
	}

	const { builds } = await loadBuilds();
	const latest = builds[0];
	if (!latest) return c.json({ configured: true, latest: null });

	return c.json({
		configured: true,
		latest: {
			...latest,
			downloadUrl: blobDownloadUrl(env.desktop.bucket, latest.fileName)
		}
	});
});

desktopRoutes.get('/releases', async (c) => {
	if (!gcsStorageConfigured()) return c.json({ configured: false, releases: [] });
	const { builds } = await loadBuilds();
	return c.json({ configured: true, releases: builds });
});

/** Every desktop app polls this endpoint, so the blob listing is shared between them. */
async function loadBuilds(): Promise<Listing> {
	if (cachedListing && Date.now() - cachedListing.fetchedAt < LISTING_TTL_MS) return cachedListing;
	pendingListing ??= fetchBuilds().finally(() => {
		pendingListing = null;
	});
	return pendingListing;
}

async function fetchBuilds(): Promise<Listing> {
	const blobs = await listBlobs(env.desktop.bucket, env.desktop.buildPrefix);
	const builds = blobs
		.map(toBuild)
		.filter((build): build is DesktopBuild => build !== null)
		.sort((a, b) => compareVersions(b.version, a.version));

	cachedListing = { builds, fetchedAt: Date.now() };
	return cachedListing;
}

function toBuild(blob: BlobEntry): DesktopBuild | null {
	const pattern = new RegExp(`^${escapeRegExp(env.desktop.buildPrefix)}(\\d+(?:\\.\\d+)*)\\.exe$`, 'i');
	const version = pattern.exec(blob.name)?.[1];
	if (!version) return null;

	return {
		version,
		fileName: blob.name,
		size: blob.size,
		publishedAt: blob.lastModified,
		sha256: blob.metadata.sha256?.toLowerCase() ?? null
	};
}

export function compareVersions(a: string, b: string) {
	const left = a.split('.').map(Number);
	const right = b.split('.').map(Number);

	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0);
		if (diff !== 0) return diff < 0 ? -1 : 1;
	}
	return 0;
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
