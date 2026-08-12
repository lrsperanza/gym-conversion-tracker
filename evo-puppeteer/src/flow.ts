import type { Page } from 'puppeteer-core';
import { checarCancelamento } from './cancelamento.ts';
import { LOGIN_URL, SELECTORS, type Prospect } from './config.ts';
import {
  aviso,
  click,
  clickMarked,
  exists,
  fill,
  fillMasked,
  isTimeoutError,
  isTransientError,
  log,
  MARKER,
  matSelectId,
  onlyDigits,
  openMatSelect,
  POLL_INTERVAL,
  readMatSelect,
  readValue,
  selectMatOption,
  sleep,
  waitFor,
  waitMatPanelClosed,
} from './dom.ts';

/** Depois disso, seguir na tela de login significa credencial recusada. */
const GRACA_LOGIN_MS = 12_000;

/** Carência para uma sessão guardada se revelar antes de acreditar na tela de login. */
const GRACA_SESSAO_MS = 5_000;

/** Quanto esperar a lista de unidades renderizar antes de desistir. */
const LISTA_MS = 5_000;

/** Quanto esperar o modal reagir ao clique no card. */
const REACAO_MS = 2_000;

/** Quanto esperar o modal fechar depois de confirmar a unidade. */
const ENTRADA_MS = 8_000;

/** Teto para insistir num clique que algum overlay está bloqueando. */
const CLIQUE_MS = 5_000;

/** O select de DDI já abre no Brasil. */
const DDI_PADRAO = '55';

/** Quanto esperar a lista de países do DDI aparecer no painel. */
const PAISES_MS = 5_000;

/** DDD + número no Brasil: 10 dígitos no fixo, 11 no celular. */
const NACIONAL = [10, 11];

/** Fatia de cada tentativa de abrir a página, para o goto não travar o cancelamento. */
const GOTO_SLICE = 15_000;

/**
 * Rede lenta pode estourar o goto; tentamos de novo até o deadline. A espera
 * vai em fatias porque um `goto` já disparado não dá para interromper — fatiar
 * mantém o fluxo cancelável enquanto a página não responde.
 */
export async function gotoComRetry(page: Page, url: string, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    checarCancelamento(page);
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(GOTO_SLICE, Math.max(deadline - Date.now(), 500)),
      });
      return;
    } catch (error) {
      if (!isTransientError(error) && !isTimeoutError(error)) throw error;
      lastError = error;
      await sleep(500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Não foi possível abrir ${url}.`);
}

export type Credenciais = { usuario: string; senha: string };
type EstadoSessao = 'login' | 'unidade' | 'ativa';

export async function login(page: Page, credenciais: Credenciais, timeout: number): Promise<void> {
  log(`abrindo ${LOGIN_URL}`);
  await gotoComRetry(page, LOGIN_URL, timeout);

  const estado = await detectarEstadoSessao(page, timeout);
  if (estado !== 'login') {
    log('sessão EVO já está ativa — pulando login');
    return;
  }

  log(`autenticando como ${credenciais.usuario}`);
  const destino = await preencherLoginAteRedirecionar(page, credenciais, timeout);
  if (destino === 'ativa' || destino === 'unidade') {
    log('a tela de login redirecionou — sessão já estava ativa');
  }
}

export async function garantirSessao(
	page: Page,
	credenciais: Credenciais,
	unidade: string,
	timeout: number,
): Promise<void> {
	// A aba é reutilizada entre atendimentos. Se o atalho já está na tela, a
	// sessão está viva e uma navegação nova faria o SPA repetir o login para
	// voltar ao mesmo lugar.
	if (await visivel(page, SELECTORS.sessaoAtiva)) {
		log('sessão EVO já está ativa — pulando login');
		return;
	}

	log(`abrindo ${LOGIN_URL}`);
	await gotoComRetry(page, LOGIN_URL, timeout);

	const estado = await detectarEstadoSessao(page, timeout);
	if (estado === 'ativa') {
		log('sessão EVO já está ativa — pulando login');
		return;
	}

	if (estado === 'unidade') {
		await escolherUnidade(page, unidade, timeout);
		await aguardarSessaoAtiva(page, timeout);
		return;
	}

	log(`autenticando como ${credenciais.usuario}`);
	const destino = await preencherLoginAteRedirecionar(page, credenciais, timeout);
	if (destino === 'ativa') {
		log('a tela de login redirecionou para a home — sessão já estava ativa');
		return;
	}
	if (destino === 'unidade') {
		log('a tela de login redirecionou para a seleção de unidade — sessão já estava ativa');
	}
	await escolherUnidade(page, unidade, timeout);
	await aguardarSessaoAtiva(page, timeout);
}

type DestinoSessao = 'entrou' | 'ativa' | 'unidade' | 'interrompido';

/**
 * Corre o preenchimento do login contra o redirect que a tela de autenticação
 * faz sozinha quando já existe sessão guardada. Se a home (ou o modal de
 * unidades) aparecer no meio do caminho, os campos somem da tela e insistir
 * neles travaria até o timeout — o redirect é o recado de que o resto do
 * login é desnecessário.
 */
async function preencherLoginAteRedirecionar(
	page: Page,
	credenciais: Credenciais,
	timeout: number,
): Promise<DestinoSessao> {
	let observando = true;
	const redirecionamento = (async (): Promise<DestinoSessao> => {
		while (observando) {
			checarCancelamento(page);
			if (await visivel(page, SELECTORS.unidade.modal)) return 'unidade';
			if (await visivel(page, SELECTORS.sessaoAtiva)) return 'ativa';
			await sleep(POLL_INTERVAL);
		}
		return 'interrompido';
	})();

	const preenchendo = (async (): Promise<DestinoSessao> => {
		await fill(page, SELECTORS.login.usuario, credenciais.usuario, timeout);
		await fill(page, SELECTORS.login.senha, credenciais.senha, timeout);
		await click(page, SELECTORS.login.entrar, timeout);
		return 'entrou';
	})();
	// O lado abandonado pelo redirect morre no próprio prazo; engolir o
	// desfecho para não derrubar o processo com rejeição sem tratamento.
	preenchendo.catch(() => undefined);

	try {
		return await Promise.race([preenchendo, redirecionamento]);
	} finally {
		observando = false;
	}
}

/**
 * A tela de autenticação exibe o formulário mesmo com sessão guardada e só
 * então redireciona para a home — acreditar nele de cara faz o fluxo esperar
 * por campos que o redirect acabou de tirar da tela. Por isso a home e o
 * modal de unidades têm prioridade, e o formulário só é levado a sério depois
 * da carência.
 */
async function detectarEstadoSessao(page: Page, timeout: number): Promise<EstadoSessao> {
	const deadline = Date.now() + timeout;
	const limiteLogin = Date.now() + Math.min(GRACA_SESSAO_MS, timeout);
	const avisar = aviso('o EVO terminar de carregar');
	do {
		checarCancelamento(page);
		if (await visivel(page, SELECTORS.unidade.modal)) return 'unidade';
		if (await visivel(page, SELECTORS.sessaoAtiva)) return 'ativa';
		if (Date.now() > limiteLogin && (await visivel(page, SELECTORS.login.usuario))) return 'login';
		avisar();
		await sleep(POLL_INTERVAL);
	} while (Date.now() < deadline);

	throw new Error('Não foi possível identificar o estado da sessão no EVO.');
}

async function aguardarSessaoAtiva(page: Page, timeout: number): Promise<void> {
	log('aguardando a tela inicial do EVO');
	if (await exists(page, SELECTORS.sessaoAtiva, timeout)) return;
	throw new Error('Login realizado, mas a tela inicial do EVO não ficou disponível.');
}

async function visivel(page: Page, selector: string): Promise<boolean> {
	return page
		.$eval(selector, (el) => {
			const element = el as HTMLElement;
			const style = window.getComputedStyle(element);
			return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
		})
		.catch(() => false);
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
  const destino = await aguardarModalOuSessao(page, timeout);
  if (destino === 'ativa') {
    log('modal de unidades não apareceu — seguindo direto');
    return false;
  }
  if (destino === 'login') {
    throw new Error('O EVO continuou na tela de login. Confira usuário e senha.');
  }
  if (destino === 'nada') {
    throw new Error('Depois do login o EVO não abriu o modal de unidades nem a tela inicial.');
  }

  log(`selecionando a unidade "${unidade}"`);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    checarCancelamento(page);
    await marcarEClicarUnidade(page, unidade, deadline);

    const reacao = await confirmarUnidade(page, deadline);
    if (reacao === 'fechou') return true;
    // Botão de confirmar parado em desabilitado é sinal claro de que o clique
    // no card não pegou: melhor repetir agora do que esperar o modal fechar.
    if (reacao !== 'sem-reacao') {
      if (await modalFechou(page, Math.min(ENTRADA_MS, deadline - Date.now()))) return true;
    }

    log('o modal de unidades continuou aberto — repetindo a seleção');
  }

  throw new Error(`Não foi possível concluir a seleção da unidade "${unidade}".`);
}

/**
 * Corre atrás dos três desfechos possíveis do login ao mesmo tempo, para
 * seguir no instante em que um deles aparece em vez de dormir um tempo fixo.
 */
async function aguardarModalOuSessao(
  page: Page,
  timeout: number,
): Promise<'unidade' | 'ativa' | 'login' | 'nada'> {
  const deadline = Date.now() + timeout;
  const limiteLogin = Date.now() + Math.min(GRACA_LOGIN_MS, timeout);
  const avisar = aviso('o modal de unidades ou a tela inicial do EVO');

  while (Date.now() < deadline) {
    checarCancelamento(page);
    if (await visivel(page, SELECTORS.unidade.modal)) return 'unidade';
    if (await visivel(page, SELECTORS.sessaoAtiva)) return 'ativa';
    if (Date.now() > limiteLogin && (await visivel(page, SELECTORS.login.usuario))) return 'login';
    avisar();
    await sleep(POLL_INTERVAL);
  }
  return 'nada';
}

/**
 * A lista de unidades chega por requisição, então o modal abre vazio. Enquanto
 * não houver uma opção parecida com a procurada seguimos tentando; passado o
 * prazo, o erro traz o que estava na tela para não ficar adivinhando.
 */
async function marcarEClicarUnidade(page: Page, unidade: string, deadline: number): Promise<void> {
  const limite = Math.min(Date.now() + LISTA_MS, deadline);
  const avisar = aviso('a lista de unidades carregar');
  let escolha = await marcarUnidade(page, unidade);

  while (escolha.tipo !== 'ok' && Date.now() < limite) {
    checarCancelamento(page);
    avisar();
    await sleep(POLL_INTERVAL);
    escolha = await marcarUnidade(page, unidade);
  }

  if (escolha.tipo !== 'ok') {
    const opcoes = escolha.tipo === 'vazio' ? [] : escolha.opcoes;
    const lista = opcoes.length ? `Na tela: ${opcoes.join(' | ')}` : 'Nada legível no modal.';
    const motivo =
      escolha.tipo === 'ambiguo'
        ? `mais de uma unidade combina com "${unidade}"`
        : `nenhuma unidade combina com "${unidade}"`;
    throw new Error(`Seleção de unidade falhou: ${motivo}. ${lista}`);
  }

  log(`unidade encontrada: "${escolha.opcao}"`);
  await clicarMarcado(page, deadline);
}

/**
 * O Angular pode repintar o modal entre marcar e clicar, o que apaga a marca.
 * Não é motivo para derrubar o fluxo: quem chamou confere se o modal fechou e
 * repete a seleção.
 */
async function clicarMarcado(page: Page, deadline: number): Promise<void> {
  try {
    await clickMarked(page, Math.min(CLIQUE_MS, Math.max(deadline - Date.now(), 500)));
  } catch (error) {
    if (!isTimeoutError(error) && !isTransientError(error)) throw error;
    log('o modal repintou antes do clique — tentando de novo');
  }
}

/** Alguns modais entram no clique do card; outros exigem confirmar depois. */
async function confirmarUnidade(
  page: Page,
  deadline: number,
): Promise<'fechou' | 'confirmado' | 'sem-botao' | 'sem-reacao'> {
  const limite = Math.min(Date.now() + REACAO_MS, deadline);
  let ultimo: BotaoConfirmar = 'ausente';

  while (Date.now() < limite) {
    checarCancelamento(page);
    if (!(await visivel(page, SELECTORS.unidade.modal))) return 'fechou';
    ultimo = await marcarConfirmacao(page);
    if (ultimo === 'clicavel') {
      await clicarMarcado(page, deadline);
      return 'confirmado';
    }
    await sleep(POLL_INTERVAL);
  }

  return ultimo === 'desabilitado' ? 'sem-reacao' : 'sem-botao';
}

async function modalFechou(page: Page, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  const avisar = aviso('o modal de unidades fechar');
  do {
    checarCancelamento(page);
    if (!(await visivel(page, SELECTORS.unidade.modal))) return true;
    avisar();
    await sleep(POLL_INTERVAL);
  } while (Date.now() < deadline);
  return false;
}

type EscolhaUnidade =
  | { tipo: 'ok'; opcao: string }
  | { tipo: 'vazio' }
  | { tipo: 'sem-match'; opcoes: string[] }
  | { tipo: 'ambiguo'; opcoes: string[] };

/**
 * Marca a unidade procurada no modal. Comparar por trecho não serve: o card
 * pode dizer só "Vila Xavier" enquanto o cadastro pede "Skyfit Vila Xavier", e
 * o container que envolve tudo contém qualquer texto que se procure. Por isso a
 * nota é um F1 entre as palavras: premia quem cobre o que foi pedido sem
 * arrastar junto o resto do modal.
 */
async function marcarUnidade(page: Page, unidade: string): Promise<EscolhaUnidade> {
  return page
    .evaluate(
      (raizes: string[], procurado: string, marcador: string): EscolhaUnidade => {
        const limpar = (valor: string) =>
          valor
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim()
            .toLowerCase();
        const palavras = (valor: string) =>
          new Set(
            limpar(valor)
              .split(/[^a-z0-9]+/)
              .filter((palavra) => palavra.length > 1),
          );
        const aparece = (el: Element) => {
          const estilo = window.getComputedStyle(el);
          return (
            estilo.visibility !== 'hidden' &&
            estilo.display !== 'none' &&
            el.getClientRects().length > 0
          );
        };

        // O modal já foi visto sob raízes diferentes; procurar em todas as que
        // estão na tela evita depender de adivinhar a certa.
        const visiveis = raizes
          .map((seletor) => document.querySelector(seletor))
          .filter((el): el is Element => el !== null && aparece(el));
        if (visiveis.length === 0) return { tipo: 'vazio' };

        const alvo = palavras(procurado);
        const candidatos = Array.from(
          new Set(visiveis.flatMap((raiz) => Array.from(raiz.querySelectorAll<HTMLElement>('*')))),
        ).filter((el) => aparece(el) && (el.textContent ?? '').trim().length > 0);
        if (alvo.size === 0 || candidatos.length === 0) return { tipo: 'vazio' };

        const folhas = candidatos.filter(
          (el) => !candidatos.some((outro) => outro !== el && el.contains(outro)),
        );
        const opcoes = Array.from(
          new Set(folhas.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())),
        ).slice(0, 30);

        const notas = candidatos.map((el) => {
          const suas = palavras(el.textContent ?? '');
          let comuns = 0;
          for (const palavra of alvo) if (suas.has(palavra)) comuns += 1;
          if (comuns === 0) return 0;
          const precisao = comuns / suas.size;
          const revocacao = comuns / alvo.size;
          return (2 * precisao * revocacao) / (precisao + revocacao);
        });

        const melhor = notas.reduce((maior, nota) => Math.max(maior, nota), 0);
        if (melhor < 0.5) return { tipo: 'sem-match', opcoes };

        const iguais = candidatos.filter((_, i) => Math.abs((notas[i] ?? 0) - melhor) < 1e-9);
        const internos = iguais.filter(
          (el) => !iguais.some((outro) => outro !== el && el.contains(outro)),
        );
        const textos = new Set(internos.map((el) => limpar(el.textContent ?? '')));
        if (textos.size > 1) return { tipo: 'ambiguo', opcoes };

        let escolhido = internos[0];
        if (!escolhido) return { tipo: 'sem-match', opcoes };

        // O <span> do nome é um alvo pequeno; sobe até o card, que é o que o
        // Angular escuta, enquanto o pai não trouxer texto de outra unidade.
        const texto = limpar(escolhido.textContent ?? '');
        while (
          escolhido.parentElement &&
          !visiveis.includes(escolhido.parentElement) &&
          limpar(escolhido.parentElement.textContent ?? '') === texto
        ) {
          escolhido = escolhido.parentElement;
        }

        document.querySelectorAll(`[${marcador}]`).forEach((el) => el.removeAttribute(marcador));
        escolhido.setAttribute(marcador, '');
        return { tipo: 'ok', opcao: (escolhido.textContent ?? '').replace(/\s+/g, ' ').trim() };
      },
      [...SELECTORS.unidade.raizes],
      unidade,
      MARKER,
    )
    .catch((): EscolhaUnidade => ({ tipo: 'vazio' }));
}

type BotaoConfirmar = 'clicavel' | 'desabilitado' | 'ausente';

/**
 * Marca o botão que confirma a unidade e conta em que estado ele está: um
 * botão que continua desabilitado denuncia que o clique no card se perdeu.
 */
async function marcarConfirmacao(page: Page): Promise<BotaoConfirmar> {
  return page
    .evaluate(
      (raizes: string[], rotulos: string[], marcador: string): BotaoConfirmar => {
        const limpar = (valor: string) =>
          valor
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        const visiveis = raizes
          .map((seletor) => document.querySelector(seletor))
          .filter((el): el is Element => el !== null);
        if (visiveis.length === 0) return 'ausente';

        const candidatos = Array.from(
          new Set(visiveis.flatMap((raiz) => Array.from(raiz.querySelectorAll('button')))),
        ).filter((el) => {
          if (el.getClientRects().length === 0) return false;
          const texto = limpar(el.textContent ?? '');
          return rotulos.some((rotulo) => texto.includes(rotulo));
        });
        if (candidatos.length === 0) return 'ausente';

        const botao = candidatos.find(
          (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true',
        );
        if (!botao) return 'desabilitado';

        document.querySelectorAll(`[${marcador}]`).forEach((el) => el.removeAttribute(marcador));
        botao.setAttribute(marcador, '');
        return 'clicavel';
      },
      [...SELECTORS.unidade.raizes],
      [...SELECTORS.unidade.confirmar],
      MARKER,
    )
    .catch((): BotaoConfirmar => 'ausente');
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

  log(`nome: ${prospect.nome}`);
  await fill(page, campos.nome, prospect.nome, timeout);

  await preencherSe(page, 'sobrenome', campos.sobrenome, prospect.sobrenome, timeout);
  await preencherSe(page, 'cpf', campos.cpf, prospect.cpf, timeout, fillMasked);
  await preencherSe(
    page,
    'data de nascimento',
    campos.nascimento,
    prospect.nascimento,
    timeout,
    fillMasked,
  );
  await selecionarSe(page, 'gênero', campos.genero, prospect.genero, timeout);

  if (await preencherSe(page, 'cep', campos.cep, prospect.cep, timeout, fillMasked)) {
    // O CEP dispara a busca de endereço, que repinta os campos seguintes.
    await sleep(1_000);
  }

  await preencherTelefone(page, prospect, timeout);
  await preencherSe(page, 'e-mail', campos.email, prospect.email, timeout);
  await selecionarSe(page, 'tipo de visita', campos.tipoVisita, prospect.tipoVisita, timeout);
  await selecionarSe(page, 'como conheceu', campos.comoConheceu, prospect.comoConheceu, timeout, {
    multiple: true,
  });
}

const informado = (valor: string | undefined): valor is string =>
  (valor ?? '').trim().length > 0;

/** Devolve se chegou a preencher, para quem precisa reagir ao campo. */
async function preencherSe(
  page: Page,
  rotulo: string,
  selector: string,
  valor: string | undefined,
  timeout: number,
  preencher: typeof fill = fill,
): Promise<boolean> {
  if (!informado(valor)) {
    log(`${rotulo}: em branco — deixando como está`);
    return false;
  }
  log(`${rotulo}: ${valor}`);
  await preencher(page, selector, valor.trim(), timeout);
  return true;
}

async function selecionarSe(
  page: Page,
  rotulo: string,
  selectId: string,
  valor: string | undefined,
  timeout: number,
  opcoes?: { multiple?: boolean },
): Promise<void> {
  if (!informado(valor)) {
    log(`${rotulo}: em branco — deixando como está`);
    return;
  }
  log(`${rotulo}: ${valor}`);
  await selectMatOption(page, selectId, valor.trim(), timeout, opcoes);
}

/**
 * No EVO o DDI mora num `mat-select` ao lado do campo do número, que espera só
 * DDD + número. Um telefone que chega em formato internacional precisa entrar
 * dividido entre os dois — digitado inteiro, o código do país viraria DDD.
 */
async function preencherTelefone(page: Page, prospect: Prospect, timeout: number): Promise<void> {
  if (!informado(prospect.telefone)) {
    log('telefone: em branco — deixando como está');
    return;
  }

  const { ddi, numero } = separarTelefone(prospect.telefone, prospect.ddi);
  await selecionarDdi(page, ddi, timeout);
  log(`telefone: ${numero}`);
  await fillMasked(page, SELECTORS.cadastro.telefone, numero, timeout);
}

/**
 * Separa o código do país do resto do telefone. O DDI informado manda; sem ele
 * sobra o que dá para deduzir do próprio número.
 */
export function separarTelefone(
  telefone: string,
  ddi?: string,
): { ddi: string; numero: string } {
  const bruto = telefone.trim();
  const explicito = onlyDigits(ddi ?? '');
  if (explicito) return { ddi: explicito, numero: semDdi(bruto, explicito) };

  // "+55 16 99612-3434": o separador já diz onde o DDI termina.
  const separado = /^\+\s*(\d{1,3})\D+(\d.*)$/.exec(bruto);
  if (separado?.[1] && separado[2]) return { ddi: separado[1], numero: onlyDigits(separado[2]) };

  const digitos = onlyDigits(bruto);
  const nacional = !bruto.startsWith('+') && digitos.length <= Math.max(...NACIONAL);
  if (nacional) return { ddi: DDI_PADRAO, numero: bruto };

  // "+5516996123434": colado, o corte é ambíguo (DDI de 1 a 3 dígitos, nacional
  // de 10 ou 11), então vale o que deixa um número nacional plausível — dois
  // dígitos na frente primeiro, que é o formato daqui.
  for (const tamanho of [2, 3, 1]) {
    const resto = digitos.slice(tamanho);
    if (NACIONAL.includes(resto.length)) return { ddi: digitos.slice(0, tamanho), numero: resto };
  }
  return { ddi: DDI_PADRAO, numero: semDdi(bruto, DDI_PADRAO) };
}

/** Só tira o DDI do começo quando ele de fato veio junto do número. */
function semDdi(telefone: string, ddi: string): string {
  const digitos = onlyDigits(telefone);
  if (!digitos.startsWith(ddi)) return telefone;

  // Um número local pode começar com os mesmos dígitos do DDI (DDD 55, por
  // exemplo); só cortamos quando o "+" ou o tamanho denunciam o país.
  const resto = digitos.slice(ddi.length);
  return telefone.startsWith('+') || resto.length >= Math.min(...NACIONAL) ? resto : telefone;
}

/**
 * Trocar o DDI custa abrir o painel e pode repintar o campo do número, então
 * quando o formulário já está no país certo não mexemos no select.
 */
async function selecionarDdi(page: Page, ddi: string, timeout: number): Promise<void> {
  const seletor = SELECTORS.cadastro.ddi;
  const atual = await readMatSelect(page, seletor).catch(() => '');
  if (onlyDigits(atual) === ddi) {
    log(`ddi: +${ddi} (já selecionado)`);
    return;
  }

  log(`ddi: +${ddi}`);
  const id = await matSelectId(page, seletor, timeout);
  await openMatSelect(page, id, timeout);

  // A lista de países pode demorar a renderizar, então o painel abre vazio.
  const limite = Date.now() + Math.min(PAISES_MS, timeout);
  const avisar = aviso('a lista de países do DDI');
  let marcado = await marcarDdi(page, id, ddi);
  while (!marcado && Date.now() < limite) {
    checarCancelamento(page);
    avisar();
    await sleep(POLL_INTERVAL);
    marcado = await marcarDdi(page, id, ddi);
  }

  if (!marcado) {
    const opcoes = await page
      .$$eval(`#${id}-panel mat-option`, (els) => els.map((el) => el.textContent?.trim() ?? ''))
      .catch(() => []);
    await page.keyboard.press('Escape').catch(() => undefined);
    const lista = opcoes.length ? `Na tela: ${opcoes.slice(0, 20).join(' | ')}` : 'Painel vazio.';
    throw new Error(`Nenhuma opção do select de DDI corresponde a +${ddi}. ${lista}`);
  }

  await clickMarked(page, timeout);
  await waitMatPanelClosed(page, id, timeout);
}

/**
 * Comparar o texto da opção não serve para DDI: "+55" também está dentro de
 * "+355". Por isso a escolha é pelos dígitos, exatos.
 */
async function marcarDdi(page: Page, painel: string, ddi: string): Promise<boolean> {
  return page
    .evaluate(
      (seletor: string, alvo: string, marcador: string): boolean => {
        const opcoes = Array.from(document.querySelectorAll<HTMLElement>(seletor));
        const escolhido = opcoes.find(
          (el) => (el.textContent ?? '').replace(/\D/g, '') === alvo,
        );
        if (!escolhido) return false;

        document.querySelectorAll(`[${marcador}]`).forEach((el) => el.removeAttribute(marcador));
        escolhido.setAttribute(marcador, '');
        return true;
      },
      `#${painel}-panel mat-option`,
      ddi,
      MARKER,
    )
    .catch(() => false);
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

  resumo.ddi = await readMatSelect(page, campos.ddi).catch(() => '(não lido)');

  for (const id of [campos.genero, campos.tipoVisita, campos.comoConheceu]) {
    resumo[id] = await readMatSelect(page, `mat-select#${id}`).catch(() => '(não lido)');
  }

  return resumo;
}
