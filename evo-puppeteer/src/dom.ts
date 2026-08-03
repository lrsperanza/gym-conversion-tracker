import type { ElementHandle, Page } from 'puppeteer-core';
import { checarCancelamento, isCancelamento } from './cancelamento.ts';

/** Sem pausa entre teclas: o preenchimento sai praticamente instantâneo. */
const DIGITACAO_RAPIDA = 0;
/** Ritmo usado apenas na segunda tentativa, quando a máscara perde teclas. */
const DIGITACAO_TOLERANTE = 40;
export const POLL_INTERVAL = 120;
const WAIT_SLICE = 5_000;
export const MARKER = 'data-evo-target';
/** Teto para esperar um elemento parar de animar antes de clicar. */
const ESTABILIDADE_MS = 1_000;
/** Quanto insistir no clique real antes de recorrer ao clique sintético. */
const CLIQUE_MS = 5_000;
/** Intervalo entre avisos de "ainda estou esperando". */
const AVISO_MS = 3_000;
/** Quanto esperar o painel de um `mat-select` sumir depois da escolha. */
const PAINEL_MS = 3_000;

export const log = (message: string) => console.log(`  · ${message}`);

/**
 * Sem isto uma espera que não resolve fica o timeout inteiro em silêncio e
 * parece travamento. Devolve uma função para chamar a cada volta do laço.
 */
export function aviso(rotulo: string): () => void {
	let proximo = Date.now() + AVISO_MS;
	return () => {
		if (Date.now() < proximo) return;
		proximo = Date.now() + AVISO_MS;
		log(`ainda aguardando ${rotulo}…`);
	};
}

/**
 * Corridas com navegação/re-render do Angular: o elemento some ou o contexto
 * morre no meio da ação, mas a página se recupera logo em seguida.
 */
const TRANSIENT_PATTERNS = [
	'Execution context was destroyed',
	'Cannot find object with id',
	'Inspected target navigated',
	'Node is detached from document',
	'Node is either not clickable',
	'failed to find element',
	'detached Frame',
	'Protocol error',
	'Session closed'
];

export const isTransientError = (error: unknown): boolean => {
	const message = error instanceof Error ? error.message : String(error);
	return TRANSIENT_PATTERNS.some((pattern) => message.includes(pattern));
};

export const isTimeoutError = (error: unknown): boolean =>
	error instanceof Error && error.name === 'TimeoutError';

const shouldRetry = (error: unknown) =>
  !isCancelamento(error) && (isTransientError(error) || isTimeoutError(error));

const remaining = (deadline: number) => Math.max(deadline - Date.now(), 500);

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Comparação tolerante a acentos, caixa e espaços duplicados. */
export const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export const onlyDigits = (value: string) => value.replace(/\D/g, '');

/** Aguarda o elemento em fatias: rede lenta ou re-render não derrubam a espera. */
export async function waitFor(
  page: Page,
  selector: string,
  timeout: number,
): Promise<ElementHandle<Element>> {
  const deadline = Date.now() + timeout;
  const avisar = aviso(`"${selector}"`);
  let lastError: unknown;
  while (Date.now() < deadline) {
    checarCancelamento(page);
    try {
      const handle = await page.waitForSelector(selector, {
        visible: true,
        timeout: Math.min(WAIT_SLICE, remaining(deadline)),
      });
      if (handle) return handle;
    } catch (error) {
      if (!shouldRetry(error)) throw error;
      lastError = error;
    }
    avisar();
    await sleep(POLL_INTERVAL);
  }

  const detalhe = lastError instanceof Error ? ` Último erro: ${lastError.message}` : '';
  const erro = new Error(`Elemento "${selector}" não apareceu em ${timeout}ms.${detalhe}`);
  erro.name = 'TimeoutError';
  throw erro;
}

export async function exists(page: Page, selector: string, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    checarCancelamento(page);
    try {
      const handle = await page.waitForSelector(selector, {
        visible: true,
        timeout: Math.min(WAIT_SLICE, remaining(deadline)),
      });
      if (handle) {
        await handle.dispose();
        return true;
      }
    } catch (error) {
      if (!shouldRetry(error)) return false;
    }
    await sleep(POLL_INTERVAL);
  }
  return false;
}

/**
 * Diálogos e overlays do Material entram animando: o Puppeteer calcula o ponto
 * do clique e o elemento já saiu de lá quando o mouse chega. Dois quadros com o
 * mesmo retângulo custam ~30ms na tela parada e evitam o clique perdido.
 */
async function esperarParar(handle: ElementHandle<Element>): Promise<void> {
	await handle
		.evaluate(
			(el, limite) =>
				new Promise<void>((resolve) => {
					const inicio = performance.now();
					let anterior = el.getBoundingClientRect();
					let iguais = 0;
					const passo = () => {
						const atual = el.getBoundingClientRect();
						iguais =
							atual.x === anterior.x &&
							atual.y === anterior.y &&
							atual.width === anterior.width &&
							atual.height === anterior.height
								? iguais + 1
								: 0;
						anterior = atual;
						if (iguais >= 2 || performance.now() - inicio > limite) return resolve();
						setTimeout(passo, 16);
					};
					setTimeout(passo, 16);
				}),
			ESTABILIDADE_MS,
		)
		.catch(() => undefined);
}

/** O backdrop do CDK cobre o diálogo enquanto ele abre e engole o clique. */
async function noTopo(handle: ElementHandle<Element>): Promise<boolean> {
	return handle
		.evaluate((el) => {
			const rect = el.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) return false;
			const x = Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1);
			const y = Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1);
			const topo = document.elementFromPoint(x, y);
			return !!topo && (topo === el || el.contains(topo) || topo.contains(el));
		})
		.catch(() => false);
}

/**
 * Clica só quando o alvo parou de se mexer e está realmente por cima. Se o
 * ponto continuar coberto, dispara o clique pelo DOM em vez de desistir.
 */
export async function clickHandle(handle: ElementHandle<Element>, timeout: number): Promise<void> {
	const deadline = Date.now() + timeout;
	const avisar = aviso('o alvo do clique ficar acessível');
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			await handle.scrollIntoView().catch(() => undefined);
			await esperarParar(handle);
			if (await noTopo(handle)) {
				await handle.click();
				return;
			}
		} catch (error) {
			if (!shouldRetry(error)) throw error;
			lastError = error;
		}
		avisar();
		await sleep(POLL_INTERVAL);
	}
	const causa = lastError instanceof Error ? lastError.message : 'alvo coberto por outro elemento';
	log(`clique real não foi possível (${causa}) — disparando pelo DOM`);
	await handle.evaluate((el) => (el as HTMLElement).click());
}

/** Clica no elemento marcado por `MARKER` e limpa a marca. */
export async function clickMarked(page: Page, timeout: number): Promise<void> {
	const handle = await waitFor(page, `[${MARKER}]`, timeout);
	try {
		await clickHandle(handle, Math.min(CLIQUE_MS, timeout));
	} finally {
		await handle.evaluate((el, marker) => el.removeAttribute(marker), MARKER).catch(() => undefined);
		await handle.dispose();
	}
}

export async function click(page: Page, selector: string, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    checarCancelamento(page);
    try {
      const handle = await waitFor(page, selector, remaining(deadline));
      await clickHandle(handle, Math.min(CLIQUE_MS, remaining(deadline)));
      await handle.dispose();
      return;
    } catch (error) {
      if (!shouldRetry(error)) throw error;
      lastError = error;
      await sleep(POLL_INTERVAL);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function limpar(page: Page, input: ElementHandle<Element>): Promise<void> {
  await input.click();
  await input.evaluate((el) => (el as HTMLInputElement).select());
  await page.keyboard.press('Backspace');
}

/** O campo pode estar formatado pela máscara, então dígitos iguais bastam. */
function valorConfere(atual: string, esperado: string): boolean {
  if (normalize(atual) === normalize(esperado)) return true;
  const digitos = onlyDigits(esperado);
  return digitos.length > 0 && onlyDigits(atual) === digitos;
}

/**
 * Os campos são inputs do Angular Material: um clique real seguido de digitação
 * garante que os eventos de máscara e validação sejam disparados. A digitação
 * vai sem pausa; se a máscara não acompanhar, repetimos em ritmo mais lento.
 */
export async function fill(
  page: Page,
  selector: string,
  value: string,
  timeout: number,
): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    checarCancelamento(page);
    try {
      const input = await waitFor(page, selector, remaining(deadline));
      await limpar(page, input);
      await input.type(value, { delay: DIGITACAO_RAPIDA });

      if (!valorConfere(await readValue(page, selector), value)) {
        await limpar(page, input);
        await input.type(value, { delay: DIGITACAO_TOLERANTE });
      }

      await input.dispose();
      return;
    } catch (error) {
      if (!shouldRetry(error)) throw error;
      lastError = error;
      await sleep(POLL_INTERVAL);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function readValue(page: Page, selector: string): Promise<string> {
  return page.$eval(selector, (el) => (el as HTMLInputElement).value ?? '');
}

/**
 * Campos com máscara (CPF, CEP, telefone, data) podem rejeitar a pontuação
 * digitada. Preenche com o valor formatado e, se os dígitos não baterem,
 * repete enviando apenas os números.
 */
export async function fillMasked(
  page: Page,
  selector: string,
  value: string,
  timeout: number,
): Promise<void> {
  await fill(page, selector, value, timeout);
  const digits = onlyDigits(value);
  if (onlyDigits(await readValue(page, selector)) !== digits) {
    await fill(page, selector, digits, timeout);
  }
}

/**
 * Os rótulos do EVO variam em acento, em palavras curtas ("veio até academia"
 * vs. "veio até a academia") e em pontuação ("TOTEM/SITE" vs. "Totem / Site"),
 * então aceitamos o texto como trecho ou como conjunto de palavras relevantes.
 */
function textoCorresponde(conteudo: string, procurado: string): boolean {
  const alvo = normalize(conteudo);
  const busca = normalize(procurado);
  if (alvo.includes(busca)) return true;

  const palavras = busca.split(/[^a-z0-9]+/).filter((palavra) => palavra.length > 2);
  return palavras.length > 0 && palavras.every((palavra) => alvo.includes(palavra));
}

async function findByText(
  page: Page,
  selector: string,
  text: string,
): Promise<ElementHandle<Element> | null> {
  for (const handle of await page.$$(selector)) {
    const content = await handle.evaluate((el) => el.textContent ?? '');
    if (textoCorresponde(content, text)) return handle;
    await handle.dispose();
  }
  return null;
}

export async function waitForText(
  page: Page,
  selector: string,
  text: string,
  timeout: number,
): Promise<ElementHandle<Element>> {
  const deadline = Date.now() + timeout;
  do {
    checarCancelamento(page);
    try {
      const handle = await findByText(page, selector, text);
      if (handle) return handle;
    } catch (error) {
      if (!shouldRetry(error)) throw error;
    }
    await sleep(POLL_INTERVAL);
  } while (Date.now() < deadline);

  const disponiveis = await page
    .$$eval(selector, (els) => els.map((el) => el.textContent?.trim() ?? ''))
    .catch(() => []);
  const lista = disponiveis.length ? `Opções na tela: ${disponiveis.join(' | ')}` : 'Nada na tela.';
  throw new Error(`Nenhum "${selector}" com o texto "${text}" em ${timeout}ms. ${lista}`);
}

export async function clickByText(
  page: Page,
  selector: string,
  text: string,
  timeout: number,
): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    checarCancelamento(page);
    try {
      const handle = await waitForText(page, selector, text, remaining(deadline));
      await clickHandle(handle, Math.min(CLIQUE_MS, remaining(deadline)));
      await handle.dispose();
      return;
    } catch (error) {
      if (!shouldRetry(error)) throw error;
      lastError = error;
      await sleep(POLL_INTERVAL);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Lê o rótulo que está aparecendo no `mat-select`. */
export async function readMatSelect(page: Page, selector: string): Promise<string> {
  return page.$eval(
    `${selector} .mat-select-value`,
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  );
}

/**
 * Nem todo `mat-select` do EVO tem id no template — o do DDI, por exemplo, fica
 * com o id que o Material gera. Como o painel de opções é `${id}-panel`, é esse
 * id gerado que precisamos descobrir antes de abrir o select.
 */
export async function matSelectId(page: Page, selector: string, timeout: number): Promise<string> {
  const handle = await waitFor(page, selector, timeout);
  try {
    const id = await handle.evaluate((el) => el.id);
    if (!id) throw new Error(`O mat-select "${selector}" está sem id: não dá para abrir o painel.`);
    return id;
  } finally {
    await handle.dispose();
  }
}

/** Abre o painel de um `mat-select` já identificado pelo id. */
export async function openMatSelect(page: Page, selectId: string, timeout: number): Promise<void> {
  await click(page, `mat-select#${selectId}`, timeout);
  await waitFor(page, `#${selectId}-panel`, timeout);
}

/**
 * Depois da escolha o painel fecha sozinho; seguir com ele na tela atrapalha o
 * resto. Painel que não fecha não é motivo para segurar o fluxo pelo timeout
 * inteiro: o próximo passo já reclama sozinho se o overlay atrapalhar.
 */
export async function waitMatPanelClosed(
  page: Page,
  selectId: string,
  timeout: number,
): Promise<void> {
  await page
    .waitForSelector(`#${selectId}-panel`, {
      hidden: true,
      timeout: Math.min(PAINEL_MS, timeout),
    })
    .catch(() => undefined);
}

/**
 * Abre um `mat-select` (o painel de opções é renderizado no overlay do CDK,
 * fora do formulário) e escolhe a opção pelo texto. Em selects de múltipla
 * escolha o painel continua aberto, então fechamos com Escape.
 */
export async function selectMatOption(
  page: Page,
  selectId: string,
  optionText: string,
  timeout: number,
  { multiple = false }: { multiple?: boolean } = {},
): Promise<void> {
  await openMatSelect(page, selectId, timeout);
  await clickByText(page, `#${selectId}-panel mat-option`, optionText, timeout);

  if (multiple) await page.keyboard.press('Escape');
  await waitMatPanelClosed(page, selectId, timeout);
}
