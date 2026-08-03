import { api } from './client';
import { bridgeFetchOptions, getBridgeBaseUrl } from './bridge';

export type DesktopAppInfo = {
	desktop: boolean;
	version: string | null;
	pid: number | null;
};

export type LatestDesktopBuild = {
	version: string;
	fileName: string;
	size: number;
	publishedAt: string;
	sha256: string | null;
	downloadUrl: string;
};

export type DesktopLatestResponse = {
	configured: boolean;
	latest: LatestDesktopBuild | null;
};

export function compareVersions(a: string, b: string) {
	const left = a.split('.').map(Number);
	const right = b.split('.').map(Number);
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0);
		if (diff !== 0) return diff < 0 ? -1 : 1;
	}
	return 0;
}

export async function fetchDesktopAppInfo(): Promise<DesktopAppInfo | null> {
	const bridgeBaseUrl = await getBridgeBaseUrl();
	if (bridgeBaseUrl === null) return null;

	try {
		const response = await fetch(
			`${bridgeBaseUrl}/evo/app-info`,
			bridgeFetchOptions({ method: 'GET', cache: 'no-store' }, bridgeBaseUrl ?? undefined)
		);
		if (!response.ok) return null;
		return (await response.json()) as DesktopAppInfo;
	} catch {
		return null;
	}
}

export async function fetchDesktopLatest(): Promise<DesktopLatestResponse> {
	return api<DesktopLatestResponse>('/api/desktop/latest');
}

export async function applyDesktopUpdate(): Promise<{ ok: boolean; version: string }> {
	const bridgeBaseUrl = await getBridgeBaseUrl();
	if (bridgeBaseUrl === null) {
		throw new Error('Bridge local indisponível para aplicar a atualização.');
	}

	const response = await fetch(
		`${bridgeBaseUrl}/evo/apply-update`,
		bridgeFetchOptions({ method: 'POST' }, bridgeBaseUrl)
	);
	const payload = await response.json().catch(() => null);
	if (!response.ok) {
		throw new Error(payload?.error?.message || 'Falha ao aplicar a atualização.');
	}
	return payload as { ok: boolean; version: string };
}
