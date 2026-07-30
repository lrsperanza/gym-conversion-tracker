import type { Page } from 'puppeteer';
import { LOGIN_URL, SELECTORS, type Prospect } from './config.ts';
import {
  click,
  clickByText,
  clickDeepestWithText,
  exists,
  fill,
  fillMasked,
  readValue,
  selectMatOption,
  sleep,
  waitFor,
} from './dom.ts';

const log = (message: string) => console.log(`  · ${message}`);

/** Tempo que o EVO leva para trocar de tela depois de um submit. */
const TRANSICAO_MS = 500;

export type Credenciais = { usuario: string; senha: string };

export async function login(page: Page, credenciais: Credenciais, timeout: number): Promise<void> {
  log(`abrindo ${LOGIN_URL}`);
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout });

  await waitFor(page, SELECTORS.login.usuario, timeout);
  log(`autenticando como ${credenciais.usuario}`);
  await fill(page, SELECTORS.login.usuario, credenciais.usuario, timeout);
  await fill(page, SELECTORS.login.senha, credenciais.senha, timeout);
  await click(page, SELECTORS.login.entrar, timeout);
  await sleep(TRANSICAO_MS);
}

/**
 * A conta tem acesso a mais de uma unidade, então o EVO abre um modal de
 * seleção. Se a conta tiver apenas uma unidade o modal não aparece.
 */
export async function escolherUnidade(
  page: Page,
  unidade: string,
  timeout: number,
): Promise<boolean> {
  // Espera curta: se o modal não vier, a conta tem uma única unidade.
  if (!(await exists(page, SELECTORS.unidade.modal, Math.min(timeout, 10_000)))) {
    log('modal de unidades não apareceu — seguindo direto');
    return false;
  }

  log(`selecionando a unidade "${unidade}"`);
  await clickDeepestWithText(page, SELECTORS.unidade.dialog, unidade, timeout);
  await clickByText(page, SELECTORS.unidade.confirmar, 'entrar', timeout);
  await sleep(TRANSICAO_MS);
  return true;
}

export async function abrirNovoCadastro(page: Page, timeout: number): Promise<void> {
  log('abrindo o formulário de novo cadastro');
  await click(page, SELECTORS.novoCadastro, timeout);
  await waitFor(page, SELECTORS.cadastro.nome, timeout);
}

export async function preencherCadastro(
  page: Page,
  prospect: Prospect,
  timeout: number,
): Promise<void> {
  const campos = SELECTORS.cadastro;

  log(`nome: ${prospect.nome} ${prospect.sobrenome}`);
  await fill(page, campos.nome, prospect.nome, timeout);
  await fill(page, campos.sobrenome, prospect.sobrenome, timeout);

  log(`cpf: ${prospect.cpf}`);
  await fillMasked(page, campos.cpf, prospect.cpf, timeout);

  log(`data de nascimento: ${prospect.nascimento}`);
  await fillMasked(page, campos.nascimento, prospect.nascimento, timeout);

  log(`gênero: ${prospect.genero}`);
  await selectMatOption(page, campos.genero, prospect.genero, timeout);

  log(`cep: ${prospect.cep}`);
  await fillMasked(page, campos.cep, prospect.cep, timeout);
  // O CEP dispara a busca de endereço, que repinta os campos seguintes.
  await sleep(1_000);

  log(`telefone: ${prospect.telefone}`);
  await fillMasked(page, campos.telefone, prospect.telefone, timeout);

  log(`e-mail: ${prospect.email}`);
  await fill(page, campos.email, prospect.email, timeout);

  log(`tipo de visita: ${prospect.tipoVisita}`);
  await selectMatOption(page, campos.tipoVisita, prospect.tipoVisita, timeout);

  log(`como conheceu: ${prospect.comoConheceu}`);
  await selectMatOption(page, campos.comoConheceu, prospect.comoConheceu, timeout, {
    multiple: true,
  });
}

/** Lê de volta o que ficou no formulário, para conferência antes de salvar. */
export async function conferirCadastro(page: Page): Promise<Record<string, string>> {
  const campos = SELECTORS.cadastro;
  const entradas: Array<[string, string]> = [
    ['nome', campos.nome],
    ['sobrenome', campos.sobrenome],
    ['cpf', campos.cpf],
    ['nascimento', campos.nascimento],
    ['cep', campos.cep],
    ['telefone', campos.telefone],
    ['email', campos.email],
  ];

  const resumo: Record<string, string> = {};
  for (const [rotulo, selector] of entradas) {
    resumo[rotulo] = await readValue(page, selector).catch(() => '(não lido)');
  }

  for (const id of [campos.genero, campos.tipoVisita, campos.comoConheceu]) {
    resumo[id] = await page
      .$eval(`mat-select#${id} .mat-select-value`, (el) => el.textContent?.trim() ?? '')
      .catch(() => '(não lido)');
  }

  return resumo;
}
