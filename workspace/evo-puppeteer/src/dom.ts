import type { ElementHandle, Page } from 'puppeteer';

/** Sem pausa entre teclas: o preenchimento sai praticamente instantâneo. */
const DIGITACAO_RAPIDA = 0;
/** Ritmo usado apenas na segunda tentativa, quando a máscara perde teclas. */
const DIGITACAO_TOLERANTE = 40;
const POLL_INTERVAL = 120;
const MARKER = 'data-evo-target';

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

export async function waitFor(
  page: Page,
  selector: string,
  timeout: number,
): Promise<ElementHandle<Element>> {
  const handle = await page.waitForSelector(selector, { visible: true, timeout });
  if (!handle) throw new Error(`Elemento não encontrado: ${selector}`);
  return handle;
}

export async function exists(page: Page, selector: string, timeout: number): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { visible: true, timeout });
    return true;
  } catch {
    return false;
  }
}

export async function click(page: Page, selector: string, timeout: number): Promise<void> {
  const handle = await waitFor(page, selector, timeout);
  await handle.click();
  await handle.dispose();
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
  const input = await waitFor(page, selector, timeout);
  await limpar(page, input);
  await input.type(value, { delay: DIGITACAO_RAPIDA });

  if (!valorConfere(await readValue(page, selector), value)) {
    await limpar(page, input);
    await input.type(value, { delay: DIGITACAO_TOLERANTE });
  }

  await input.dispose();
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
 * Os rótulos do EVO variam em acento e em palavras curtas ("veio até academia"
 * vs. "veio até a academia"), então aceitamos o texto como trecho ou como
 * conjunto de palavras relevantes.
 */
function textoCorresponde(conteudo: string, procurado: string): boolean {
  const alvo = normalize(conteudo);
  const busca = normalize(procurado);
  if (alvo.includes(busca)) return true;

  const palavras = busca.split(' ').filter((palavra) => palavra.length > 2);
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
    const handle = await findByText(page, selector, text);
    if (handle) return handle;
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
  const handle = await waitForText(page, selector, text, timeout);
  await handle.click();
  await handle.dispose();
}

/**
 * Clica no elemento mais interno que contém o texto dentro de `root`. Útil
 * quando o alvo não tem id/classe estável e só o conteúdo o identifica.
 */
export async function clickDeepestWithText(
  page: Page,
  root: string,
  text: string,
  timeout: number,
): Promise<void> {
  const target = normalize(text);
  const deadline = Date.now() + timeout;

  do {
    const marked = await page.evaluate(
      (rootSelector, wanted, marker) => {
        const clean = (value: string) =>
          value
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        const container = document.querySelector(rootSelector);
        if (!container) return false;

        const matches = Array.from(container.querySelectorAll('*')).filter((el) =>
          clean(el.textContent ?? '').includes(wanted),
        );
        const deepest = matches.find(
          (el) => !matches.some((other) => other !== el && el.contains(other)),
        );
        if (!deepest) return false;

        deepest.setAttribute(marker, '');
        return true;
      },
      root,
      target,
      MARKER,
    );

    if (marked) {
      const handle = await waitFor(page, `[${MARKER}]`, timeout);
      await handle.click();
      await handle.evaluate((el, marker) => el.removeAttribute(marker), MARKER);
      await handle.dispose();
      return;
    }

    await sleep(POLL_INTERVAL);
  } while (Date.now() < deadline);

  throw new Error(`Nada com o texto "${text}" foi encontrado dentro de "${root}"`);
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
  await click(page, `mat-select#${selectId}`, timeout);
  await waitFor(page, `#${selectId}-panel`, timeout);
  await clickByText(page, `#${selectId}-panel mat-option`, optionText, timeout);

  if (multiple) await page.keyboard.press('Escape');
  await page
    .waitForSelector(`#${selectId}-panel`, { hidden: true, timeout })
    .catch(() => undefined);
}
