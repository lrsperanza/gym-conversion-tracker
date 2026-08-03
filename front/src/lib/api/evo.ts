import { ApiError } from './client';
import { bridgeFetchOptions, getBridgeBaseUrl, getBridgeDiagnostics } from './bridge';
import { describeError, evoError, evoLog, evoWarn } from './evo-log.svelte';

export async function evoAvailable(): Promise<boolean> {
	const available = (await getBridgeBaseUrl()) !== null;
	if (!available) {
		evoWarn('A tela perguntou se o EVO está disponível e a resposta foi não.', {
			diagnostico: getBridgeDiagnostics()
		});
	}
	return available;
}

export async function evoApi<T>(path: string, options: RequestInit = {}): Promise<T> {
	const method = options.method ?? 'GET';
	const bridgeBaseUrl = await getBridgeBaseUrl();

	if (bridgeBaseUrl === null) {
		evoError(`${method} ${path} cancelado: o bridge não está acessível.`, {
			diagnostico: getBridgeDiagnostics()
		});
		throw new ApiError('Bridge EVO indisponível.', 0);
	}

	const url = `${bridgeBaseUrl}${path}`;
	const startedAt = performance.now();
	const elapsed = () => Math.round(performance.now() - startedAt);
	evoLog(`${method} ${path} ...`);

	let response: Response;
	try {
		response = await fetch(
			url,
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
	} catch (error) {
		evoError(`${method} ${path} não completou: a conexão com o bridge caiu no meio da chamada.`, {
			url,
			latenciaMs: elapsed(),
			erro: describeError(error)
		});
		throw new ApiError('Bridge EVO indisponível.', 0);
	}

	const payload = await response.json().catch(() => null);
	if (!response.ok) {
		// The bridge answered, so the failure is inside the EVO automation, not in the connection.
		evoError(`${method} ${path} respondeu HTTP ${response.status}: o bridge recusou a operação.`, {
			latenciaMs: elapsed(),
			mensagem: payload?.error?.message ?? null,
			detalhes: payload?.error?.details ?? null
		});
		throw new ApiError(
			payload?.error?.message || 'Erro na integração EVO.',
			response.status,
			payload?.error?.details
		);
	}

	evoLog(`${method} ${path} OK em ${elapsed()} ms.`);
	return payload as T;
}
