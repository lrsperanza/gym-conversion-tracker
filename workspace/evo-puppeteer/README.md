# evo-puppeteer

CLI em Bun + Puppeteer que abre o EVO (`evo5.w12app.com.br`), faz login, escolhe a
unidade e preenche um novo cadastro de prospect. **O formulário não é salvo** — o
script para com os campos preenchidos e deixa o navegador aberto para conferência.

## Instalação

```bash
bun install
```

Copie o `.env.example` para `.env` e informe as credenciais:

```bash
EVO_USUARIO=seu-email@exemplo.com
EVO_SENHA=sua-senha
```

## Uso

```bash
bun start
```

O navegador abre visível (não headless), maximizado, e executa:

1. login em `#/acesso/skyfitacademia/autenticacao`;
2. seleção da unidade no modal multiunidade (padrão: Vila Xavier);
3. atalho **novo cadastro** no topo;
4. preenchimento de nome, sobrenome, CPF, data de nascimento, gênero, CEP,
   telefone celular, e-mail, tipo de visita e como conheceu.

No fim, os valores lidos de volta do formulário são exibidos em tabela e o
navegador fica aberto até você apertar `Ctrl+C`.

## Opções

```bash
bun start --help
```

| Flag | Descrição |
| --- | --- |
| `--usuario`, `--senha` | credenciais (sobrescrevem o `.env`) |
| `--unidade` | texto usado para localizar a unidade no modal |
| `--nome`, `--sobrenome`, `--cpf`, `--nascimento`, `--genero`, `--cep`, `--telefone`, `--email`, `--tipo-visita`, `--como-conheceu` | dados do cadastro |
| `--timeout <ms>` | espera máxima por elemento (padrão 30000) |
| `--slow-mo <ms>` | atraso entre ações, útil para acompanhar visualmente |
| `--headless` | roda sem interface |
| `--fechar` | fecha o navegador ao terminar em vez de aguardar |

Exemplo com outro prospect:

```bash
bun start --nome "aluno 2" --sobrenome "sobrenome 2" --cpf 41946265837 --slow-mo 80
```

## Estrutura

| Arquivo | Papel |
| --- | --- |
| `index.ts` | entrada do CLI |
| `src/cli.ts` | flags, launch do Puppeteer, tratamento de erro |
| `src/flow.ts` | passos do fluxo (login, unidade, cadastro) |
| `src/dom.ts` | helpers para inputs/`mat-select` do Angular Material |
| `src/config.ts` | URL, seletores e valores padrão |

Se algum passo falhar, um screenshot da tela é salvo em `screenshots/`.
