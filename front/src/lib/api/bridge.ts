import { browser } from '$app/environment';
import {
	describeError,
	evoDiagnostics,
	evoError,
	evoLog,
	evoWarn,
	setEvoDiagnostics
} from './evo-log.svelte';

const CONFIGURED_BRIDGE_URL = String(import.meta.env.PUBLIC_EVO_URL || '').trim();
const LOCAL_BRIDGE_URL = (CONFIGURED_BRIDGE_URL || 'http://localhost:4000').replace(/\/$/, '');
const HEALTH_PATH = '/evo/health';
const HEALTH_TIMEOUT_MS = 6000;
const BRIDGE_SERVICE = 'evo-bridge';
const BODY_SNIPPET_LENGTH = 180;

type LocalNetworkRequestInit = RequestInit & {
	targetAddressSpace?: 'loopback';
};

export type BridgeProbe = {
	label: string;
	url: string;
	ok: boolean;
	latencyMs: number;
	status?: number;
	service?: string;
	reason?: string;
	hint?: string;
};

export type BridgeDiagnostics = {
	checkedAt: string;
	baseUrl: string | null;
	environment: Record<string, unknown>;
	probes: BridgeProbe[];
};

let bridgeBaseUrlPromise: Promise<string | null> | null = null;

export function resetBridgeDetection() {
	bridgeBaseUrlPromise = null;
}

export function getBridgeDiagnostics(): BridgeDiagnostics | null {
	return evoDiagnostics();
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
	const environment = environmentInfo();
	evoLog('Iniciando detecção do bridge.', environment);
	warnAboutEnvironment(environment);

	const probes: BridgeProbe[] = [];
	let baseUrl: string | null = null;

	// The desktop app serves the front through the bridge itself, so same origin is the happy path.
	probes.push(await probeBridge('', 'mesma origem'));
	if (probes[0].ok) {
		baseUrl = '';
	} else {
		probes.push(await probeBridge(LOCAL_BRIDGE_URL, 'bridge local'));
		if (probes[1].ok) baseUrl = LOCAL_BRIDGE_URL;
	}

	setEvoDiagnostics({ checkedAt: new Date().toISOString(), baseUrl, environment, probes });

	if (baseUrl === null) {
		evoError('Bridge indisponível: nenhuma das origens testadas respondeu como evo-bridge.', {
			tentativas: probes.map((probe) => `${probe.label} (${probe.url}): ${probe.reason}`),
			comoResolver: RESOLUTION_STEPS
		});
	} else {
		evoLog(`Bridge conectado em "${baseUrl || window.location.origin}".`, {
			origem: baseUrl === '' ? 'mesma origem' : 'bridge local',
			latenciaMs: probes.at(-1)?.latencyMs
		});
	}

	return baseUrl;
}

async function probeBridge(baseUrl: string, label: string): Promise<BridgeProbe> {
	const url = `${baseUrl || window.location.origin}${HEALTH_PATH}`;
	// A same origin miss is expected whenever the front is not served by the bridge,
	// so it is reported as a warning to keep the real failure visible.
	const sameOrigin = baseUrl === '';
	const report = sameOrigin ? evoWarn : evoError;
	const blocked = mixedContentReason(baseUrl);
	if (blocked) {
		evoError(`Teste "${label}" bloqueado antes de sair do navegador: ${blocked.reason}`, {
			url,
			dica: blocked.hint
		});
		return { label, url, ok: false, latencyMs: 0, ...blocked };
	}

	evoLog(`Testando "${label}" em ${url} ...`);
	const startedAt = performance.now();
	const elapsed = () => Math.round(performance.now() - startedAt);

	try {
		const response = await fetch(
			url,
			bridgeFetchOptions(
				{ method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) },
				baseUrl
			)
		);
		const latencyMs = elapsed();
		const body = await response.text().catch(() => '');
		const payload = parseJson(body);
		const service = typeof payload?.service === 'string' ? payload.service : undefined;

		if (!response.ok) {
			const probe: BridgeProbe = {
				label,
				url,
				ok: false,
				latencyMs,
				status: response.status,
				service,
				reason: `respondeu HTTP ${response.status}`,
				hint: sameOrigin
					? 'Esperado quando o front não é servido pelo bridge. O teste que vale é o do bridge local, abaixo.'
					: 'Algo atende nessa porta, mas devolveu erro. Veja o log do bridge em %LOCALAPPDATA%\\SkyfitEVO\\data\\logs.'
			};
			report(`Teste "${label}" falhou: HTTP ${response.status}.`, {
				url,
				latenciaMs: latencyMs,
				corpo: snippet(body),
				dica: probe.hint
			});
			return probe;
		}

		if (service !== BRIDGE_SERVICE) {
			const probe: BridgeProbe = {
				label,
				url,
				ok: false,
				latencyMs,
				status: response.status,
				service,
				reason: `respondeu HTTP 200, mas o serviço é "${service ?? 'desconhecido'}"`,
				hint: sameOrigin
					? 'O front está sendo servido direto da web, não pelo bridge. O app desktop abriu no modo remoto de fallback.'
					: 'Outro programa está ocupando essa porta. Feche-o ou mude a porta do bridge.'
			};
			evoWarn(`Teste "${label}" respondeu, mas não é o evo-bridge.`, {
				url,
				latenciaMs: latencyMs,
				servicoRecebido: service ?? null,
				contentType: response.headers.get('content-type'),
				corpo: snippet(body),
				dica: probe.hint
			});
			return probe;
		}

		evoLog(`Teste "${label}" OK em ${latencyMs} ms.`, { url, resposta: payload });
		return { label, url, ok: true, latencyMs, status: response.status, service };
	} catch (error) {
		const latencyMs = elapsed();
		const { reason, hint } = classifyFetchFailure(error, baseUrl);
		report(`Teste "${label}" falhou: ${reason}`, {
			url,
			latenciaMs: latencyMs,
			erro: describeError(error),
			dica: hint
		});
		return { label, url, ok: false, latencyMs, reason, hint };
	}
}

const RESOLUTION_STEPS = [
	'1. Confirme que o processo bridge.exe está rodando no Gerenciador de Tarefas.',
	'2. Abra http://localhost:4000/evo/health no navegador do PC: deve responder {"ok":true,"service":"evo-bridge"}.',
	'3. Veja os logs do bridge em %LOCALAPPDATA%\\SkyfitEVO\\data\\logs\\bridge.err.log.',
	'4. Libere o bridge.exe e a porta 4000 no antivírus e no Firewall do Windows.',
	'5. Verifique se outro programa já ocupa a porta 4000 (netstat -ano | findstr :4000).'
];

function environmentInfo(): Record<string, unknown> {
	return {
		origem: window.location.origin,
		url: window.location.href,
		protocolo: window.location.protocol,
		servidoPeloBridge: window.location.origin === LOCAL_BRIDGE_URL,
		bridgeConfigurado: CONFIGURED_BRIDGE_URL || `${LOCAL_BRIDGE_URL} (padrão)`,
		navegadorOnline: navigator.onLine,
		userAgent: navigator.userAgent
	};
}

function warnAboutEnvironment(environment: Record<string, unknown>) {
	if (environment.servidoPeloBridge) return;

	// In the desktop build the bridge also serves the front, so a remote origin means the
	// launcher gave up on the local bridge and fell back to the hosted front.
	evoWarn(
		`O front está vindo de ${window.location.origin}, e não do bridge em ${LOCAL_BRIDGE_URL}. No app desktop isso quer dizer que o bridge local não subiu na inicialização e o launcher abriu o front remoto.`,
		{ comoResolver: RESOLUTION_STEPS }
	);
}

function mixedContentReason(baseUrl: string): { reason: string; hint: string } | null {
	if (window.location.protocol !== 'https:' || !baseUrl.startsWith('http://')) return null;
	return {
		reason: `a página está em HTTPS e o bridge em HTTP (${baseUrl}), então o navegador bloqueia a chamada como conteúdo misto`,
		hint: 'Feche e reabra o app até ele iniciar em http://localhost:4000; enquanto o front vier da web em HTTPS, o EVO não funciona.'
	};
}

function classifyFetchFailure(error: unknown, baseUrl: string): { reason: string; hint: string } {
	if (error instanceof DOMException && error.name === 'TimeoutError') {
		return {
			reason: `nenhuma resposta em ${HEALTH_TIMEOUT_MS} ms`,
			hint: 'A porta aceitou a conexão mas o bridge travou ou está muito lento para responder.'
		};
	}

	if (error instanceof DOMException && error.name === 'AbortError') {
		return {
			reason: 'a requisição foi cancelada',
			hint: 'A página foi recarregada durante o teste.'
		};
	}

	if (error instanceof TypeError) {
		return {
			reason: 'a conexão nem chegou a ser feita (falha de rede, CORS ou bloqueio local)',
			hint: baseUrl
				? 'Causas comuns: bridge.exe não está rodando, antivírus/firewall bloqueando a porta 4000, ou o navegador barrando acesso à rede local.'
				: 'A própria origem da página não respondeu ao teste de saúde.'
		};
	}

	return {
		reason: 'erro inesperado ao chamar o bridge',
		hint: 'Veja o campo "erro" para o detalhe cru.'
	};
}

function parseJson(body: string): Record<string, unknown> | null {
	try {
		return JSON.parse(body) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function snippet(body: string) {
	const clean = body.replace(/\s+/g, ' ').trim();
	return clean.length > BODY_SNIPPET_LENGTH ? `${clean.slice(0, BODY_SNIPPET_LENGTH)}...` : clean;
}
