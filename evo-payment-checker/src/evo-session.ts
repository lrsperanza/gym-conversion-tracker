import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AUTH_URL, codigoTotpFresco, garantirSessao, LOGIN_URL, sleep } from 'evo-puppeteer';
import puppeteer, { type Browser, type BrowserContext, type HTTPRequest, type Page } from 'puppeteer-core';
import type { EvoCredentials } from './db.ts';
import { env } from './env.ts';
import { nextLoginStep, type EvoLoginResponse } from './evo-login.ts';
import type { EvoClient, EvoReportRow, EvoVenda } from './matching.ts';

/**
 * Headers que o próprio SPA do EVO manda para `evo-abc-api`. Capturamos de uma
 * requisição real depois do login em vez de remontar à mão: a `chaveIdFilial`
 * e a `chaveIdW12` são cifradas pelo EVO e mudam por unidade.
 */
const API_HEADERS = ['authorization', 'dns', 'filial', 'chaveidfilial', 'chaveidw12', 'idw12', 'accept-language'];

const HEADER_WAIT_MS = 20_000;
const DEFAULT_API_ORIGIN = 'https://evo-abc-api.w12app.com.br';
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

let realUserAgent = '';

/**
 * O EVO fica atrás do Cloudflare, que bloqueia o Chrome headless ("Sorry, you
 * have been blocked"). Por isso o padrão é Chrome com janela — no container
 * ela vive num Xvfb (veja o Dockerfile). Mesmo assim tiramos o "Headless" da
 * user-agent e a flag de automação, caso alguém rode com EVO_HEADLESS=true.
 */
export async function launchBrowser(): Promise<Browser> {
	const browser = await puppeteer.launch({
		executablePath: resolveChromePath(),
		headless: env.headless,
		defaultViewport: { width: 1366, height: 900 },
		ignoreDefaultArgs: ['--enable-automation'],
		args: [
			'--no-sandbox',
			'--disable-dev-shm-usage',
			'--disable-blink-features=AutomationControlled',
			'--lang=pt-BR',
			'--window-size=1366,900'
		]
	});
	realUserAgent = (await browser.userAgent()).replace(/HeadlessChrome/g, 'Chrome');
	return browser;
}

async function preparePage(page: Page): Promise<Page> {
	if (realUserAgent) await page.setUserAgent(realUserAgent).catch(() => undefined);
	await page.emulateTimezone(env.timeZone).catch(() => undefined);
	return page;
}

let lastLoginAt = 0;

/** O mesmo código 2FA não pode ser usado em dois logins seguidos: espera a próxima janela de 30s. */
async function waitTotpWindow(): Promise<void> {
	const sinceLast = Date.now() - lastLoginAt;
	if (lastLoginAt && sinceLast < 31_000) await sleep(31_000 - sinceLast);
}

const normalizeUnit = (value: string) =>
	value
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.trim();

/**
 * Sessão EVO logada numa unidade. Cada unidade ganha um contexto anônimo
 * próprio: trocar de unidade dentro da mesma sessão exigiria refazer o login
 * de qualquer forma, e o contexto isolado garante headers da unidade certa.
 */
export class EvoSession {
	private headers: Record<string, string> | null = null;
	private apiOrigin = '';
	/** Aba logada no EVO 3 (relatórios gerenciais legados), aberta sob demanda. */
	private evo3Page: Page | null = null;
	/** Token de SSO do EVO 3 quando o login foi pela API (sem o storage do SPA). */
	private tokenEvo3: string | null = null;
	/** Por onde a última sessão entrou — vai para `payment_check_runs`. */
	loginMethod: 'api' | 'tela' | null = null;

	private constructor(
		private readonly context: BrowserContext,
		private readonly page: Page,
		private readonly credentials: EvoCredentials,
		readonly unit: string
	) {}

	static async open(browser: Browser, credentials: EvoCredentials, unit: string): Promise<EvoSession> {
		const context = await browser.createBrowserContext();
		const page = await preparePage(await context.newPage());
		const session = new EvoSession(context, page, credentials, unit);
		page.on('request', (request) => session.capture(request));
		// Diagnóstico: respostas de erro do EVO/Cloudflare aparecem no log do job.
		page.on('response', (response) => {
			const url = response.url();
			if (response.status() >= 400 && /w12app\.com\.br/.test(url)) {
				void response
					.text()
					.catch(() => '')
					.then((body) =>
						console.warn(`[evo] HTTP ${response.status()} ${url.split('?')[0]} ${body.replace(/\s+/g, ' ').slice(0, 300)}`)
					);
			}
		});
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

	/**
	 * Login pela API do EVO (o mesmo `POST /api/v1/auth/login` que a tela chama),
	 * que não depende de seletores nem do layout. A tela fica só de reserva para
	 * quando a API mudar.
	 */
	private async login(): Promise<void> {
		await waitTotpWindow();
		let apiError: unknown;
		try {
			await this.loginViaApi();
			this.loginMethod = 'api';
			return;
		} catch (error) {
			apiError = error;
			console.warn(`[evo] login pela API falhou (${(error as Error).message}); tentando pela tela.`);
		} finally {
			lastLoginAt = Date.now();
		}
		await waitTotpWindow();
		try {
			await this.loginViaScreen();
			this.loginMethod = 'tela';
		} catch (error) {
			throw new Error(
				`Login no EVO falhou pela API (${(apiError as Error).message}) e pela tela (${(error as Error).message}).`
			);
		}
	}

	private async loginViaApi(): Promise<void> {
		const dns = /#\/(?:app|acesso)\/([^/]+)\//.exec(AUTH_URL)?.[1];
		if (!dns) throw new Error(`não deu para ler o DNS de ${AUTH_URL}`);
		console.info(`[evo] login pela API na unidade "${this.unit || '(única)'}"`);
		// A chamada sai de dentro de uma página do EVO para passar pelo Cloudflare e pelo CORS como o SPA.
		this.headers = null;
		this.tokenEvo3 = null;
		await this.page.goto(AUTH_URL, { waitUntil: 'domcontentloaded', timeout: env.timeoutMs });
		const fusoHorario = await this.page.evaluate(() => new Date().getTimezoneOffset()).catch(() => 180);
		const base = {
			dns,
			login: this.credentials.usuario,
			senha: this.credentials.senha,
			fusoHorario,
			gofit: false,
			idFilial: null
		};
		let next = nextLoginStep(await this.loginStep({ ...base, etapaAtual: 1, chaveOTP: '' }));
		if (next.kind === 'totp') {
			if (!this.credentials.segredoTotp) throw new Error('o EVO pede 2FA e não há segredo TOTP salvo');
			const codigoDuploFator = await codigoTotpFresco(this.credentials.segredoTotp);
			next = nextLoginStep(
				await this.loginStep({ ...base, codigoDuploFator, etapaAtual: 3, chaveOTP: next.chaveOTP })
			);
			if (next.kind === 'totp') throw new Error('o EVO recusou o código 2FA');
		}
		if (next.kind === 'error') throw new Error(next.message);
		const { token, user } = next;
		if (
			this.unit &&
			(user.filiais?.length ?? 0) > 1 &&
			!normalizeUnit(user.nomeFilial ?? '').includes(normalizeUnit(this.unit))
		) {
			throw new Error(`a conta abriu a unidade "${user.nomeFilial}", não "${this.unit}"`);
		}
		this.headers = {
			accept: 'application/json, text/plain, */*',
			'accept-language': 'pt-BR',
			authorization: `Bearer ${token}`,
			dns,
			filial: String(user.idFilial),
			chaveidfilial: String(user.idFilialCripto ?? ''),
			chaveidw12: String(user.idW12Cripto ?? ''),
			idw12: String(user.idW12 ?? '')
		};
		this.apiOrigin = DEFAULT_API_ORIGIN;
		this.tokenEvo3 = user.tokenEvo3 || null;
		await this.request('GET', '/api/v1/auth/logado', undefined, false);
		console.info(`[evo] sessão pronta pela API (filial ${user.idFilial}).`);
	}

	/** Uma etapa do login; o corpo leva a senha, então nunca vai para o log. */
	private async loginStep(body: Record<string, unknown>): Promise<EvoLoginResponse> {
		const result = await this.page.evaluate(
			async (url: string, body: string) => {
				const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
				return { status: response.status, text: await response.text() };
			},
			`${DEFAULT_API_ORIGIN}/api/v1/auth/login`,
			JSON.stringify(body)
		);
		if (result.status !== 200) {
			throw new Error(`auth/login etapa ${body.etapaAtual} → HTTP ${result.status}: ${result.text.slice(0, 200)}`);
		}
		return JSON.parse(result.text) as EvoLoginResponse;
	}

	/** Caminho antigo: preenche a tela de login com o `evo-puppeteer` e captura os headers do SPA. */
	private async loginViaScreen(): Promise<void> {
		console.info(`[evo] login pela tela na unidade "${this.unit || '(única)'}" (user-agent: ${realUserAgent || 'padrão'})`);
		// Diagnóstico: durante o login, registra a tela sempre que o texto mudar.
		let lastSeen = '';
		const watcher = setInterval(() => {
			void this.page
				.evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 400))
				.then((text) => {
					const seen = `${this.page.url()} | ${text}`;
					if (seen !== lastSeen) console.info(`[evo] tela: ${seen}`);
					lastSeen = seen;
				})
				.catch(() => undefined);
		}, 2_000);
		try {
			// O evo-puppeteer tem sua própria cópia do puppeteer-core; os tipos de Page não
			// casam entre cópias, mas o objeto é o mesmo protocolo em tempo de execução.
			await garantirSessao(this.page as unknown as Parameters<typeof garantirSessao>[0], this.credentials, this.unit, env.timeoutMs);
		} catch (error) {
			// O evo-puppeteer reconhece a sessão pelo botão "Novo cadastro" do topo. No
			// container (Xvfb, CPU menor) o topo às vezes não renderiza esse atalho a
			// tempo, mesmo com o login concluído. Se a URL já é da área logada
			// (#/app/<dns>/<filial>/...), seguimos: a captura dos headers abaixo é quem
			// prova que a sessão vale.
			if (/#\/app\/[^/]+\/\d+\//.test(this.page.url())) {
				console.warn(`[evo] login concluído (url ${this.page.url()}), mas o atalho da home não apareceu: ${(error as Error).message}`);
			} else {
				await this.screenshot('login');
				throw error;
			}
		} finally {
			clearInterval(watcher);
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
		let headers = captured();
		if (!headers) {
			// No container o SPA às vezes fica em "Carregando" depois do 2FA e não chama a
			// API. O login em si já valeu: o EVO gravou token e usuário no storage, e dá
			// para montar os mesmos headers a partir deles.
			headers = await this.headersFromStorage();
			if (headers) {
				this.headers = headers;
				this.apiOrigin = DEFAULT_API_ORIGIN;
				console.warn('[evo] nenhuma chamada da tela observada; usando headers montados do storage do EVO.');
			}
		}
		if (!headers) {
			await this.screenshot('headers');
			throw new Error('Login no EVO feito, mas nenhuma chamada autenticada à API foi observada.');
		}
		// Confirma que a sessão vale antes de seguir.
		await this.request('GET', '/api/v1/auth/logado', undefined, false);
		console.info(`[evo] sessão pronta (filial ${headers.filial}).`);
	}

	/** Mesmos headers que o SPA monta, a partir do que o EVO guarda após o login. */
	private async headersFromStorage(): Promise<Record<string, string> | null> {
		return this.page
			.evaluate(() => {
				const parse = (raw: string | null) => {
					try {
						return raw ? JSON.parse(raw) : null;
					} catch {
						return null;
					}
				};
				const token = parse(localStorage.getItem('evo.authToken'));
				const user = parse(sessionStorage.getItem('evo.user')) ?? parse(localStorage.getItem('evo.user'));
				const filial =
					sessionStorage.getItem('evo.idFilialAtivo') ?? /#\/app\/[^/]+\/(\d+)\//.exec(location.href)?.[1] ?? null;
				const dns = parse(localStorage.getItem('evo.DNS')) ?? /#\/app\/([^/]+)\//.exec(location.href)?.[1] ?? null;
				if (typeof token !== 'string' || !user || !filial || !dns) return null;
				return {
					accept: 'application/json, text/plain, */*',
					'accept-language': 'pt-BR',
					authorization: `Bearer ${token}`,
					dns: String(dns),
					filial: String(filial),
					chaveidfilial: String(user.idFilialCripto ?? ''),
					chaveidw12: String(user.idW12Cripto ?? ''),
					idw12: String(user.idW12 ?? '')
				} as Record<string, string>;
			})
			.catch(() => null);
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

	/**
	 * Gerencial › Vendas (EVO 3), aba "Vendas detalhadas", tipo Contrato.
	 * O EVO 5 só embute essa tela num iframe com um token de SSO; abrimos o
	 * mesmo endereço numa aba do mesmo contexto e chamamos o endpoint do grid
	 * (`listarVendas`, Kendo aspnetmvc-ajax) com o token anti-forgery da página.
	 */
	async salesReport(from: Date, to: Date): Promise<EvoReportRow[]> {
		const page = await this.openEvo3Vendas();
		const fmt = (date: Date) => date.toLocaleDateString('pt-BR', { timeZone: env.timeZone });
		const rows: EvoReportRow[] = [];
		const pageSize = 500;
		for (let pageNumber = 1; pageNumber <= 40; pageNumber += 1) {
			const result = await page.evaluate(
				async (params: Record<string, string>) => {
					// O token do formulário precisa casar com o cookie anti-forgery atual, que
					// muda se o EVO 3 for aberto de novo (ex.: pelo iframe do EVO 5). Buscar a
					// tela de novo garante um par cookie/token consistente.
					const html = await fetch('/Gerencial/Gerencial/Index/VENDAS', { credentials: 'include' }).then((r) => r.text());
					const fresh = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(html)?.[1];
					const token =
						fresh ?? document.querySelector<HTMLInputElement>('input[name="__RequestVerificationToken"]')?.value ?? '';
					const response = await fetch('/Gerencial/Vendas/listarVendas', {
						method: 'POST',
						headers: {
							'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
							'x-requested-with': 'XMLHttpRequest'
						},
						body: new URLSearchParams({ __RequestVerificationToken: token, ...params })
					});
					return { status: response.status, text: await response.text() };
				},
				{
					sort: '',
					page: String(pageNumber),
					pageSize: String(pageSize),
					group: '',
					filter: '',
					IdFuncionario: '',
					IdFuncionarioComis: '',
					Inicio: fmt(from),
					Fim: fmt(to),
					Contrato: 'true',
					Produto: 'false',
					Servico: 'false',
					DebitoRecorrente: 'false',
					TrocaDeContrato: 'false',
					ContratosAdicionais: 'false',
					ContratosAdicionaisOpcionais: 'false',
					FL_MANUAIS: 'true',
					FL_ONLINE: 'true',
					FL_CONTRATO_SECUNDARIO: 'false',
					idsContrato: '',
					idsProduto: '',
					idsServico: '',
					ConsideraEspecial: 'true'
				}
			);
			if (result.status !== 200) {
				throw new Error(`EVO3 listarVendas → ${result.status}: ${result.text.slice(0, 300)}`);
			}
			const data = JSON.parse(result.text) as { Data?: EvoReportRow[]; Total?: number };
			const batch = data.Data ?? [];
			rows.push(...batch);
			if (batch.length < pageSize || rows.length >= (data.Total ?? 0)) break;
			await sleep(API_PAUSE_MS);
		}
		console.info(`[evo] relatório de vendas ${fmt(from)}–${fmt(to)}: ${rows.length} venda(s) de contrato.`);
		return rows;
	}

	private async openEvo3Vendas(): Promise<Page> {
		if (this.evo3Page && !this.evo3Page.isClosed()) return this.evo3Page;
		if (!this.headers) throw new Error('Sessão EVO sem headers de API.');
		const dns = this.headers.dns;
		const filial = this.headers.filial;

		// Caminho direto: o mesmo endereço de SSO que o EVO 5 põe no iframe, montado com
		// o token que ele guarda em localStorage (já vem codificado para URL).
		// Login pela API: o token vem no usuário, cru. Login pela tela: o SPA guarda
		// o mesmo token já codificado para URL.
		const tokenEvo3 = this.tokenEvo3
			? /%[0-9a-f]{2}/i.test(this.tokenEvo3)
				? this.tokenEvo3
				: encodeURIComponent(this.tokenEvo3)
			: await this.page
					.evaluate(() => {
						try {
							return JSON.parse(localStorage.getItem('evo.tokenEvo3') ?? 'null') as string | null;
						} catch {
							return null;
						}
					})
					.catch(() => null);
		if (tokenEvo3) {
			const url =
				`https://evo3.w12app.com.br/Login/LogarEvo3?TokenEvo3=${tokenEvo3}&idFilial=${filial}` +
				'&redirectToView=Index/VENDAS&redirectToController=Gerencial&redirectToArea=Gerencial';
			const page = await preparePage(await this.context.newPage());
			try {
				await page.goto(url, { waitUntil: 'domcontentloaded', timeout: env.timeoutMs });
				await page.waitForSelector('input[name="__RequestVerificationToken"]', { timeout: env.timeoutMs });
				this.evo3Page = page;
				return page;
			} catch (error) {
				console.warn(`[evo] SSO direto no EVO 3 falhou (${(error as Error).message}); tentando pelo iframe.`);
				await page.close().catch(() => undefined);
			}
		}

		const shell = `https://evo5.w12app.com.br/#/app/${dns}/${filial}/evo3/-Gerencial-Gerencial-Index-VENDAS`;
		await this.page.goto(shell, { waitUntil: 'domcontentloaded', timeout: env.timeoutMs });

		const deadline = Date.now() + env.timeoutMs;
		let src = '';
		while (!src && Date.now() < deadline) {
			src = await this.page
				.$$eval('iframe', (frames) => frames.map((frame) => (frame as HTMLIFrameElement).src).find((url) => url.includes('LogarEvo3')) ?? '')
				.catch(() => '');
			if (!src) await sleep(300);
		}
		if (!src) {
			await this.screenshot('evo3-iframe');
			throw new Error('O EVO não abriu o iframe do relatório Gerencial › Vendas (sem permissão?).');
		}

		// Tira a aba principal da tela do iframe: senão o iframe pode refazer o login no
		// EVO 3 e trocar o cookie anti-forgery enquanto usamos a outra aba.
		await this.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: env.timeoutMs }).catch(() => undefined);
		const page = await preparePage(await this.context.newPage());
		await page.goto(src, { waitUntil: 'domcontentloaded', timeout: env.timeoutMs });
		await page.waitForSelector('input[name="__RequestVerificationToken"]', { timeout: env.timeoutMs });
		this.evo3Page = page;
		return page;
	}

	private async screenshot(label: string): Promise<void> {
		try {
			const text = await this.page
				.evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 1500))
				.catch(() => '');
			console.error(`[evo] ${label}: url=${this.page.url()} título="${await this.page.title().catch(() => '')}" texto="${text}"`);
		} catch {
			// diagnóstico apenas
		}
		try {
			await mkdir(env.screenshotsDir, { recursive: true });
			const path = join(env.screenshotsDir, `erro-${label}-${Date.now()}.png`);
			await this.page.screenshot({ path, fullPage: true });
			console.error(`[evo] screenshot salvo em ${path} (url: ${this.page.url()})`);
			if (Bun.env.EVO_LOG_SCREENSHOTS === 'true') {
				// No Cloud Run o disco some com o container: o JPEG vai em base64 para o log.
				const jpeg = await this.page.screenshot({ type: 'jpeg', quality: 35 });
				console.error(`[evo] screenshot-b64 ${label} ${Buffer.from(jpeg).toString('base64')}`);
			}
		} catch {
			// screenshot é só diagnóstico
		}
	}

	async close(): Promise<void> {
		await this.context.close().catch(() => undefined);
	}
}
