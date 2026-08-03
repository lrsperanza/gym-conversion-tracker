import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { DEFAULT_PROSPECT, DEFAULT_UNIDADE, type Prospect } from './config.ts';
import { sleep } from './dom.ts';
import {
  abrirNovoCadastro,
  conferirCadastro,
  escolherUnidade,
  login,
  preencherCadastro,
} from './flow.ts';

const OPTIONS = {
  usuario: { type: 'string' },
  senha: { type: 'string' },
  unidade: { type: 'string' },
  nome: { type: 'string' },
  sobrenome: { type: 'string' },
  cpf: { type: 'string' },
  nascimento: { type: 'string' },
  genero: { type: 'string' },
  cep: { type: 'string' },
  ddi: { type: 'string' },
  telefone: { type: 'string' },
  email: { type: 'string' },
  'tipo-visita': { type: 'string' },
  'como-conheceu': { type: 'string' },
  timeout: { type: 'string' },
  'slow-mo': { type: 'string' },
  headless: { type: 'boolean' },
  fechar: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

const HELP = `
evo-puppeteer — abre o EVO, faz login e preenche um novo cadastro (sem salvar).

Uso:
  bun start [opções]

Credenciais (padrão: variáveis EVO_USUARIO / EVO_SENHA do .env):
  --usuario <email>          e-mail de acesso ao EVO
  --senha <senha>            senha de acesso
  --unidade <texto>          unidade a selecionar no modal (padrão: "${DEFAULT_UNIDADE}")

Dados do cadastro:
  --nome, --sobrenome, --cpf, --nascimento, --genero, --cep,
  --telefone, --email, --tipo-visita, --como-conheceu
  --ddi <código>             país do telefone, sem o "+" (padrão: 55)

Execução:
  --timeout <ms>             espera máxima por elemento (padrão: 30000)
  --slow-mo <ms>             atraso entre ações do Puppeteer (padrão: 0)
  --headless                 roda sem interface (padrão: navegador visível)
  --fechar                   fecha o navegador ao terminar em vez de aguardar
  -h, --help                 mostra esta ajuda

O formulário nunca é salvo: o script para com os campos preenchidos.
`.trim();

function numero(valor: string | undefined, padrao: number): number {
  const parsed = Number(valor);
  return valor === undefined || Number.isNaN(parsed) ? padrao : parsed;
}

async function capturarErro(page: Page): Promise<string | null> {
  try {
    await mkdir('screenshots', { recursive: true });
    const caminho = `screenshots/erro-${Date.now()}.png`;
    await page.screenshot({ path: caminho, fullPage: true });
    return caminho;
  } catch {
    return null;
  }
}

/** Mantém o processo (e o navegador) vivo até o usuário apertar Ctrl+C. */
function aguardarInterrupcao(): Promise<void> {
  return new Promise((resolve) => process.once('SIGINT', () => resolve()));
}

export async function run(argv = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const usuario = values.usuario ?? process.env.EVO_USUARIO;
  const senha = values.senha ?? process.env.EVO_SENHA;
  if (!usuario || !senha) {
    throw new Error(
      'Credenciais ausentes. Defina EVO_USUARIO e EVO_SENHA no .env ou use --usuario/--senha.',
    );
  }

  const prospect: Prospect = {
    nome: values.nome ?? DEFAULT_PROSPECT.nome,
    sobrenome: values.sobrenome ?? DEFAULT_PROSPECT.sobrenome,
    cpf: values.cpf ?? DEFAULT_PROSPECT.cpf,
    nascimento: values.nascimento ?? DEFAULT_PROSPECT.nascimento,
    genero: values.genero ?? DEFAULT_PROSPECT.genero,
    cep: values.cep ?? DEFAULT_PROSPECT.cep,
    // Sem --ddi o código do país sai do próprio telefone.
    ddi: values.ddi,
    telefone: values.telefone ?? DEFAULT_PROSPECT.telefone,
    email: values.email ?? DEFAULT_PROSPECT.email,
    tipoVisita: values['tipo-visita'] ?? DEFAULT_PROSPECT.tipoVisita,
    comoConheceu: values['como-conheceu'] ?? DEFAULT_PROSPECT.comoConheceu,
  };

  const timeout = numero(values.timeout, 120_000);
  const unidade = values.unidade ?? DEFAULT_UNIDADE;

  const browser: Browser = await puppeteer.launch({
    headless: values.headless ?? false,
    slowMo: numero(values['slow-mo'], 0),
    defaultViewport: null,
    args: ['--start-maximized'],
  });

  const [page = await browser.newPage()] = await browser.pages();
  page.setDefaultTimeout(timeout);

  try {
    await login(page, { usuario, senha }, timeout);
    await escolherUnidade(page, unidade, timeout);
    await abrirNovoCadastro(page, timeout);

    const inicio = Date.now();
    await preencherCadastro(page, prospect, timeout);

    console.log(`\nFormulário preenchido em ${Date.now() - inicio}ms (nada foi salvo):`);
    console.table(await conferirCadastro(page));
  } catch (erro) {
    const caminho = await capturarErro(page);
    console.error(`\nFalhou: ${erro instanceof Error ? erro.message : erro}`);
    if (caminho) console.error(`Screenshot: ${caminho}`);
    process.exitCode = 1;
  }

  if (values.fechar) {
    await sleep(500);
    await browser.close();
    return;
  }

  console.log('\nNavegador aberto para conferência. Ctrl+C encerra e fecha.');
  await aguardarInterrupcao();
  await browser.close();
}
