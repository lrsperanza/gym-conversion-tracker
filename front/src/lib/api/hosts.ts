import { browser } from '$app/environment';
import { getBridgeBaseUrl } from './bridge';

export type ApiHost = {
	id: string;
	label: string;
	/** Empty string means "same origin": the front is served by the bridge or by a proxy. */
	url: string;
};

export type ConnectionCheck = {
	ok: boolean;
	status: number;
	latencyMs: number;
	service?: string;
	error?: string;
};

type LocalNetworkRequestInit = RequestInit & {
	targetAddressSpace?: 'loopback';
};

const STORAGE_KEY = 'skyfit:api-host';
const CHECK_PATH = '/api/check-connection';
const CHECK_TIMEOUT_MS = 5000;
const BACK_SERVICE = 'gym-conversion-tracker-back';
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]', '::1'];

export const DEFAULT_API_URL = trimUrl(import.meta.env.PUBLIC_API_URL || 'http://localhost:3000');

const BRIDGE_URL = trimUrl(import.meta.env.PUBLIC_EVO_URL || 'http://localhost:4000');
const EXTRA_URLS: string[] = String(import.meta.env.PUBLIC_API_HOSTS || '')
	.split(',')
	.map(trimUrl)
	.filter(Boolean);

/** Hosts the app can talk to, in the order the Ctrl+D switcher cycles through them. */
export function apiHosts(): ApiHost[] {
	const candidates: ApiHost[] = [
		{ id: 'same-origin', label: 'Mesma origem', url: '' },
		{ id: 'cloud', label: 'Nuvem', url: DEFAULT_API_URL },
		{ id: 'local-back', label: 'Backend local', url: 'http://localhost:3000' },
		{ id: 'local-bridge', label: 'Bridge local', url: BRIDGE_URL },
		...EXTRA_URLS.map((url) => ({ id: url, label: hostLabel(url), url }))
	];

	const seen = new Set<string>();
	return candidates.filter((host) => {
		if (seen.has(host.url)) return false;
		seen.add(host.url);
		return true;
	});
}

export function findApiHost(url: string): ApiHost {
	return apiHosts().find((host) => host.url === url) ?? { id: url, label: hostLabel(url), url };
}

export function nextApiHost(currentUrl: string): ApiHost {
	const hosts = apiHosts();
	const index = hosts.findIndex((host) => host.url === currentUrl);
	return hosts[(index + 1) % hosts.length];
}

export function getApiHostOverride(): string | null {
	if (!browser) return null;
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored === null) return null;
	return apiHosts().some((host) => host.url === stored) ? stored : null;
}

export function setApiHostOverride(url: string) {
	if (browser) localStorage.setItem(STORAGE_KEY, url);
}

export function clearApiHostOverride() {
	if (browser) localStorage.removeItem(STORAGE_KEY);
}

/** Host the API client is using right now: the manual override, or the auto-detected one. */
export async function resolveApiHostUrl(): Promise<string> {
	const override = getApiHostOverride();
	if (override !== null) return override;
	return (await getBridgeBaseUrl()) === '' ? '' : DEFAULT_API_URL;
}

export async function checkConnection(url: string): Promise<ConnectionCheck> {
	const startedAt = performance.now();
	const elapsed = () => Math.round(performance.now() - startedAt);

	try {
		const response = await fetch(`${url}${CHECK_PATH}`, loopbackOptions(url, {
			method: 'GET',
			cache: 'no-store',
			signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
		}));
		const payload = (await response.json().catch(() => null)) as { service?: string } | null;

		if (!response.ok) {
			return { ok: false, status: response.status, latencyMs: elapsed(), error: `HTTP ${response.status}` };
		}
		if (payload?.service !== BACK_SERVICE) {
			return {
				ok: false,
				status: response.status,
				latencyMs: elapsed(),
				service: payload?.service,
				error: 'Respondeu, mas não é a API do tracker.'
			};
		}

		return { ok: true, status: response.status, latencyMs: elapsed(), service: payload.service };
	} catch (error) {
		return {
			ok: false,
			status: 0,
			latencyMs: elapsed(),
			error: error instanceof DOMException && error.name === 'TimeoutError' ? 'Tempo esgotado.' : 'Host inacessível.'
		};
	}
}

export function hostLabel(url: string) {
	if (!url) return 'Mesma origem';
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

export function hostDescription(url: string) {
	return url || (browser ? window.location.origin : 'mesma origem');
}

function trimUrl(value: string) {
	return value.trim().replace(/\/$/, '');
}

function loopbackOptions(url: string, options: RequestInit): LocalNetworkRequestInit {
	return isLoopback(url) ? { ...options, targetAddressSpace: 'loopback' } : options;
}

function isLoopback(url: string) {
	if (!url) return false;
	try {
		return LOOPBACK_HOSTNAMES.includes(new URL(url).hostname);
	} catch {
		return false;
	}
}
