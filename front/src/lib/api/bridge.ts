import { browser } from '$app/environment';

const LOCAL_BRIDGE_URL = (import.meta.env.PUBLIC_EVO_URL || 'http://localhost:4000').replace(
	/\/$/,
	''
);
const HEALTH_PATH = '/evo/health';

type LocalNetworkRequestInit = RequestInit & {
	targetAddressSpace?: 'loopback';
};

let bridgeBaseUrlPromise: Promise<string | null> | null = null;

export function resetBridgeDetection() {
	bridgeBaseUrlPromise = null;
}

export async function getBridgeBaseUrl(): Promise<string | null> {
	if (!browser) return null;
	bridgeBaseUrlPromise ??= detectBridgeBaseUrl();
	return bridgeBaseUrlPromise;
}

export function bridgeFetchOptions(
	options: RequestInit = {},
	bridgeBaseUrl = ''
): LocalNetworkRequestInit {
	return bridgeBaseUrl
		? ({ ...options, targetAddressSpace: 'loopback' } as LocalNetworkRequestInit)
		: options;
}

async function detectBridgeBaseUrl(): Promise<string | null> {
	if (await isBridge('')) return '';
	return (await isBridge(LOCAL_BRIDGE_URL)) ? LOCAL_BRIDGE_URL : null;
}

async function isBridge(baseUrl: string): Promise<boolean> {
	try {
		const response = await fetch(
			`${baseUrl}${HEALTH_PATH}`,
			bridgeFetchOptions({ method: 'GET', cache: 'no-store' }, baseUrl)
		);
		const payload = await response.json().catch(() => null);
		return response.ok && payload?.service === 'evo-bridge';
	} catch {
		return false;
	}
}
