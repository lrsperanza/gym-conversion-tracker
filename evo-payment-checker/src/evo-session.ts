import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { garantirSessao, LOGIN_URL, sleep } from 'evo-puppeteer';
import puppeteer, { type Browser, type BrowserContext, type HTTPRequest, type Page } from 'puppeteer-core';
import type { EvoCredentials } from './db.ts';
import { env } from './env.ts';
import type { EvoClient, EvoVenda } from './matching.ts';

/**
 * Headers que o próprio SPA do EVO manda para `evo-abc-api`. Capturamos de uma
 * requisição real depois do login em vez de remontar à mão: a `chaveIdFilial`
 * e a `chaveIdW12` são cifradas pelo EVO e mudam por unidade.
 */
const API_HEADERS = ['authorization', 'dns', 'filial', 'chaveidfilial', 'chaveidw12', 'idw12', 'accept-language'];

const HEADER_WAIT_MS = 20_000;
const API_PAUSE_MS = 250;

export function resolveChromePath(): string {
	const candidates = [
		env.chromePath,
		'/usr/bin/chromium',
		'/usr/bin/chromium-browser',
		'/usr/bin/google-chrome',
		join(Bun.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
		join(Bun.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
		join(Bun.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
	].filter(Boolean);
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) throw new Error('Chrome/Chromium não encontrado. Defina EVO_CHROME_PATH.');
	return found;
}

export async function launchBrowser(): Promise<Browser> {
	return puppeteer.launch({
		executablePath: resolveChromePath(),
		headless: env.headless,
		defaultViewport: { width: 1366, height: 900 },
		args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=pt-BR', '--window-size=1366,900']
	});
}

let lastLoginAt = 0;

/**
 * Sessão EVO logada numa unidade. Cada unidade ganha um contexto anônimo
 * próprio: trocar de unidade dentro da mesma sessão exigiria refazer o login
 * de qualquer forma, e o contexto isolado garante headers da unidade certa.
 */
export class EvoSession {
	private headers: Record<string, string> | null = null;
	private apiOrigin = '';

	private constructor(
		private readonly context: BrowserContext,
		private readonly page: Page,
		private readonly credentials: EvoCredentials,
		readonly unit: string
	) {}

	static async open(browser: Browser, credentials: EvoCredentials, unit: string): Promise<EvoSession> {
		const context = await browser.createBrowserContext();
		const page = await context.newPage();
		await page.emulateTimezone(env.timeZone).catch(() => undefined);
		const session = new EvoSession(context, page, credentials, unit);
		page.on('request', (request) => session.capture(request));
		await session.login();
		return session;
	}

	private capture(request: HTTPRequest): void {
		const url = request.url();
		if (!/evo-abc-api\.w12app\.com\.br\/api\//.test(url)) return;
		const raw = request.headers();
		if (!raw.authorization?.startsWith('Bearer ') || !raw.filial) return;
		const headers: Record<string, string> = { accept: 'application/json, text/plain, */*' };
		for (const name of API_HEADERS) if (raw[name]) headers[name] = raw[name]!;
		this.headers = headers;
		this.apiOrigin = new URL(url).origin;
	}

	private async login(): Promise<void> {
		// O mesmo código 2FA não pode ser usado em dois logins seguidos: se a
		// unidade anterior acabou de logar, espera a próxima janela de 30s.
		const sinceLast = Date.now() - lastLoginAt;
		if (lastLoginAt && sinceLast < 31_000) await sleep(31_000 - sinceLast);

		console.info(`[evo] login na unidade "${this.unit || '(única)'}"`);
		try {
			await garantirSessao(this.page, this.credentials, this.unit, env.timeoutMs);
		} catch (error) {
			await this.screenshot('login');
			throw error;
		}
		lastLoginAt = Date.now();

		// Requisições anteriores à escolha da unidade carregam outro contexto;
		// recarrega para capturar os headers já da unidade escolhida.
		this.headers = null;
		await this.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: env.timeoutMs }).catch(() => undefined);
		// `capture` preenche os headers num callback; o getter evita o narrowing do TS para null.
		const captured = () => this.headers as Record<string, string> | null;
		const deadline = Date.now() + HEADER_WAIT_MS;
		while (!captured() && Date.now() < deadline) await sleep(200);
		const headers = captured();
		if (!headers) {
			await this.screenshot('headers');
			throw new Error('Login no EVO feito, mas nenhuma chamada autenticada à API foi observada.');
		}
		console.info(`[evo] sessão pronta (filial ${headers.filial}).`);
	}

	private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, retry = true): Promise<T> {
		if (!this.headers) throw new Error('Sessão EVO sem headers de API.');
		const headers = { ...this.headers, ...(body ? { 'content-type': 'application/json' } : {}) };
		const url = `${this.apiOrigin}${path}`;
		const result = await this.page.evaluate(
			async (url: string, method: string, headers: Record<string, string>, body: string | null) => {
				const response = await fetch(url, { method, headers, body: body ?? undefined });
				return { status: response.status, text: await response.text() };
			},
			url,
			method,
			headers,
			body ? JSON.stringify(body) : null
		);
		await sleep(API_PAUSE_MS);

		if (result.status === 401 && retry) {
			console.warn('[evo] API respondeu 401 — refazendo login.');
			await this.login();
			return this.request<T>(method, path, body, false);
		}
		if (result.status < 200 || result.status >= 300) {
			throw new Error(`EVO ${method} ${path} → ${result.status}: ${result.text.slice(0, 300)}`);
		}
		return JSON.parse(result.text) as T;
	}

	/** Mesma busca da barra do topo do EVO: aceita nome, CPF, e-mail ou ID. */
	async searchClients(query: string): Promise<EvoClient[]> {
		const params = new URLSearchParams({
			pesquisa: query,
			tipo: '-1',
			skip: '0',
			take: '24',
			idFilial: 'null',
			pesquisaOutrasFiliais: 'false',
			tipoPesquisa: 'Padrao'
		});
		const data = await this.request<{ clienteListViewModel?: EvoClient[] }>('GET', `/api/v1/clientes/basicos?${params}`);
		return data.clienteListViewModel ?? [];
	}

	/** Histórico de vendas do cliente (aba "Vendas" do perfil), com valor pago e recebimentos. */
	async salesHistory(idCliente: number, from: Date, to: Date): Promise<EvoVenda[]> {
		const vendas: EvoVenda[] = [];
		const take = 50;
		for (let skip = 0; skip < 500; skip += take) {
			const data = await this.request<{ vendas?: EvoVenda[] }>('POST', '/api/v1/venda/historico-vendas-cliente', {
				skip,
				take,
				idVenda: '',
				tipoOrdenacao: 'desc',
				ordenarPor: 'ID_VENDA',
				flContrato: true,
				flServico: true,
				flProduto: true,
				flAtividade: true,
				idCliente: String(idCliente),
				idProspect: 0,
				dtVendaDe: from.toISOString(),
				dtVendaAte: to.toISOString(),
				dtCobrancaDe: null,
				dtCobrancaAte: null,
				dtPrevisaoCobrancaDe: null,
				dtPrevisaoCobrancaAte: null,
				idsTipoRecebimento: [],
				inicioContratoDe: null,
				inicioContratoAte: null
			});
			const page = data.vendas ?? [];
			vendas.push(...page);
			if (page.length < take) break;
		}
		return vendas;
	}

	private async screenshot(label: string): Promise<void> {
		try {
			await mkdir(env.screenshotsDir, { recursive: true });
			const path = join(env.screenshotsDir, `erro-${label}-${Date.now()}.png`);
			await this.page.screenshot({ path, fullPage: true });
			console.error(`[evo] screenshot salvo em ${path} (url: ${this.page.url()})`);
		} catch {
			// screenshot é só diagnóstico
		}
	}

	async close(): Promise<void> {
		await this.context.close().catch(() => undefined);
	}
}
