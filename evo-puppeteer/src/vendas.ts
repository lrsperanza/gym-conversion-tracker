import type { Page } from 'puppeteer-core';
import { checarCancelamento, isCancelamento } from './cancelamento.ts';
import { novaVendaUrl, SELECTORS } from './config.ts';
import {
  aviso,
  clickDom,
  exists,
  isTimeoutError,
  isTransientError,
  onlyDigits,
  POLL_INTERVAL,
  sleep,
  waitFor,
} from './dom.ts';
import { gotoComRetry } from './flow.ts';

const VALOR_MS = 4_000;
const SETTLE_MS = 300;
/** Quanto esperar o painel abrir depois do clique antes de rearmar e repetir. */
const ABERTURA_MS = 2_500;
/** Quanto esperar o painel fechar depois da escolha antes de considerar o clique engolido. */
const FECHAMENTO_MS = 1_500;

export type ContratoVenda = {
  id: string;
  nome: string;
  valorCents: number;
};

type ContratoOpcao = {
  id: string;
  nome: string;
};

export { novaVendaUrl };

export async function listarContratosVenda(page: Page, timeout: number): Promise<ContratoVenda[]> {
  await abrirPaginaNovaVenda(page, timeout);
  const opcoes = await listarOpcoesContrato(page, timeout);
  if (opcoes.length === 0) throw new Error('Nenhum contrato disponível apareceu na tela de nova venda.');

  const contratos: ContratoVenda[] = [];
  let valorAnterior = await lerValorVenda(page).catch(() => '');

  for (const opcao of opcoes) {
    await selecionarContrato(page, opcao, timeout);
    const textoValor = await aguardarValorVenda(page, valorAnterior, VALOR_MS);
    valorAnterior = textoValor;
    const valorCents = valorVendaCents(textoValor);
    if (valorCents === null) continue;
    contratos.push({ id: opcao.id, nome: opcao.nome, valorCents });
  }

  return contratos;
}

async function abrirPaginaNovaVenda(page: Page, timeout: number): Promise<void> {
  const url = novaVendaUrl(page.url().includes('w12app.com.br') ? page.url() : undefined);
  await gotoComRetry(page, url, timeout);
  try {
    await waitFor(page, SELECTORS.venda.contratos, timeout);
  } catch (error) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.min(timeout, 15_000) });
    await waitFor(page, SELECTORS.venda.contratos, timeout);
  }
}

async function listarOpcoesContrato(page: Page, timeout: number): Promise<ContratoOpcao[]> {
  await abrirSelectContratos(page, timeout);
  const opcoes = await page.$$eval(SELECTORS.venda.opcoesAbertas, (els) =>
    els
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => ({
        id: el.getAttribute('value') ?? '',
        nome: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
      }))
      .filter((opcao) => opcao.id && opcao.nome),
  );
  await page.keyboard.press('Escape').catch(() => undefined);
  // Sem esperar o fechamento, a volta seguinte pode achar o painel ainda
  // abrindo/fechando e clicar numa opção que já está saindo de cena.
  await painelFechou(page, FECHAMENTO_MS);
  return opcoes;
}

/**
 * Escolher a opção não basta: o painel fechar é a confirmação de que o clique
 * pegou. Painel que continua aberto significa clique engolido — o Escape
 * descarta o estado e a próxima volta tenta de novo, em vez de gravar o valor
 * do contrato anterior.
 */
async function selecionarContrato(page: Page, opcao: ContratoOpcao, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  const restante = () => Math.max(deadline - Date.now(), 500);
  const avisar = aviso(`a seleção do contrato "${opcao.nome}"`);
  let lastError: unknown;

  while (Date.now() < deadline) {
    checarCancelamento(page);
    try {
      await abrirSelectContratos(page, restante());
      if ((await clicarOpcaoContrato(page, opcao.id)) && (await painelFechou(page, FECHAMENTO_MS))) {
        await sleep(SETTLE_MS);
        return;
      }
      await page.keyboard.press('Escape').catch(() => undefined);
    } catch (error) {
      if (isCancelamento(error) || (!isTransientError(error) && !isTimeoutError(error))) throw error;
      lastError = error;
    }
    avisar();
    await sleep(POLL_INTERVAL);
  }

  const detalhe = lastError instanceof Error ? ` Último erro: ${lastError.message}` : '';
  throw new Error(`Não foi possível selecionar o contrato "${opcao.nome}" no EVO em ${timeout}ms.${detalhe}`);
}

/**
 * O clique real nunca passa pelo overlay desta tela, então o select é aberto
 * pelo DOM assim que aparece. Um clique só nem sempre abre o painel (o
 * AngularJS pode ficar com o estado entreaberto): cada tentativa espera pouco
 * pelas opções e, se não vierem, o Escape rearma antes de repetir — em vez de
 * esperar o timeout inteiro por um painel que não vai abrir.
 */
async function abrirSelectContratos(page: Page, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  const restante = () => Math.max(deadline - Date.now(), 500);
  const avisar = aviso(`"${SELECTORS.venda.opcoesAbertas}"`);
  let lastError: unknown;

  while (Date.now() < deadline) {
    checarCancelamento(page);
    try {
      // Painel já aberto (a escolha anterior não colou): reaproveita em vez de clicar de novo.
      if (await exists(page, SELECTORS.venda.opcoesAbertas, POLL_INTERVAL)) return;

      await clickDom(page, SELECTORS.venda.contratos, restante());
      if (await exists(page, SELECTORS.venda.opcoesAbertas, Math.min(ABERTURA_MS, restante()))) return;

      await page.keyboard.press('Escape').catch(() => undefined);
    } catch (error) {
      if (isCancelamento(error) || (!isTransientError(error) && !isTimeoutError(error))) throw error;
      lastError = error;
    }
    avisar();
    await sleep(POLL_INTERVAL);
  }

  const detalhe = lastError instanceof Error ? ` Último erro: ${lastError.message}` : '';
  const erro = new Error(
    `A lista de contratos do EVO não abriu em ${timeout}ms.${detalhe}`,
  );
  erro.name = 'TimeoutError';
  throw erro;
}

/**
 * Encontra a opção visível e dispara o clique pelo DOM no mesmo evaluate.
 * Separar em marca + clique abre janela para o Angular repintar o painel e
 * apagar a marca entre uma chamada e outra.
 */
async function clicarOpcaoContrato(page: Page, id: string): Promise<boolean> {
  return page
    .evaluate(
      (selector: string, value: string): boolean => {
        const alvo = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
          (el) => el.getAttribute('value') === value && el.getClientRects().length > 0,
        );
        if (!alvo) return false;
        alvo.click();
        return true;
      },
      SELECTORS.venda.opcoesAbertas,
      id,
    )
    .catch(() => false);
}

/** O painel do md-select some quando a escolha (ou o Escape) é registrada. */
async function painelFechou(page: Page, timeout: number): Promise<boolean> {
  return page
    .waitForSelector(SELECTORS.venda.opcoesAbertas, { hidden: true, timeout })
    .then(() => true)
    .catch(() => false);
}

async function aguardarValorVenda(page: Page, anterior: string, timeout: number): Promise<string> {
  const deadline = Date.now() + timeout;
  const avisar = aviso('o valor do contrato carregar');
  let ultimo = '';

  while (Date.now() < deadline) {
    checarCancelamento(page);
    ultimo = await lerValorVenda(page).catch(() => '');
    if (ultimo && ultimo !== anterior) return ultimo;
    avisar();
    await sleep(POLL_INTERVAL);
  }

  return ultimo || anterior;
}

async function lerValorVenda(page: Page): Promise<string> {
  return page.$eval(SELECTORS.venda.valor, (el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim());
}

function valorVendaCents(texto: string): number | null {
  const digitos = onlyDigits(texto);
  if (!digitos) return null;
  return Number.parseInt(digitos, 10);
}
