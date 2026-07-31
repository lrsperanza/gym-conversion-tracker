import { ApiError } from './client';
import { bridgeFetchOptions, getBridgeBaseUrl } from './bridge';

export async function evoAvailable(): Promise<boolean> {
	return (await getBridgeBaseUrl()) !== null;
}

export async function evoApi<T>(path: string, options: RequestInit = {}): Promise<T> {
	const bridgeBaseUrl = await getBridgeBaseUrl();
	if (bridgeBaseUrl === null) {
		throw new ApiError('Bridge EVO indisponível.', 0);
	}

	const response = await fetch(
		`${bridgeBaseUrl}${path}`,
		bridgeFetchOptions(
			{
				...options,
				headers: {
					'Content-Type': 'application/json',
					...options.headers
				}
			},
			bridgeBaseUrl
		)
	);

	const payload = await response.json().catch(() => null);
	if (!response.ok) {
		throw new ApiError(
			payload?.error?.message || 'Erro na integração EVO.',
			response.status,
			payload?.error?.details
		);
	}

	return payload as T;
}
