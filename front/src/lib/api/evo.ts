import { ApiError } from './client';

const EVO_URL = (import.meta.env.PUBLIC_EVO_URL || '').replace(/\/$/, '');

export async function evoAvailable(): Promise<boolean> {
	try {
		const response = await fetch(`${EVO_URL}/evo/health`, { credentials: 'include' });
		return response.ok;
	} catch {
		return false;
	}
}

export async function evoApi<T>(path: string, options: RequestInit = {}): Promise<T> {
	const response = await fetch(`${EVO_URL}${path}`, {
		...options,
		credentials: 'include',
		headers: {
			'Content-Type': 'application/json',
			...options.headers
		}
	});

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
