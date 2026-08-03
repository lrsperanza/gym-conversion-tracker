# evo-puppeteer — automação do EVO

Biblioteca Puppeteer que preenche o formulário de novo cadastro no EVO (`evo5.w12app.com.br`, Angular Material). Consumida em processo pelo `evo-bridge`; também tem CLI para depurar o fluxo isoladamente.

Contexto do monorepo: [`../gym-conversion-tracker-workspace/AGENTS.md`](../gym-conversion-tracker-workspace/AGENTS.md).

## Comandos

| Comando | O que faz |
|---------|-----------|
| `bun run start` | Roda o CLI (`index.ts` → `run()` de `src/cli.ts`) |
| `bun run typecheck` | `tsc --noEmit` |

Depende só de `puppeteer-core` — **sem Chromium embutido**. O Chrome do sistema é obrigatório.

## API pública

`src/index.ts` é o que o `evo-bridge` importa:

- de `config.ts`: `SELECTORS`, `DRAWER`, `LOGIN_URL`, `DEFAULT_PROSPECT`, `DEFAULT_UNIDADE`, tipo `Prospect`
- de `flow.ts`: `garantirSessao`, `login`, `escolherUnidade`, `abrirNovoCadastro`, `preencherCadastro`, `conferirCadastro`
- de `dom.ts`: `sleep`

`separarTelefone` existe em `flow.ts` mas não é reexportado.

## Arquivos

| Arquivo | Responsabilidade |
|---------|------------------|
| `index.ts` (raiz) | Shebang do CLI |
| `src/index.ts` | Reexports da biblioteca |
| `src/cli.ts` | Parse de args, `puppeteer.launch` próprio, orquestração, screenshot de erro |
| `src/config.ts` | `LOGIN_URL`, `SELECTORS`, `DRAWER`, tipo `Prospect`, defaults |
| `src/flow.ts` | Os passos da automação (~658 linhas) |
| `src/dom.ts` | Helpers de espera/clique/preenchimento com retry |

## O fluxo

1. **`garantirSessao`** — `gotoComRetry` até `LOGIN_URL`, depois `detectarEstadoSessao` decide entre três estados: formulário de login (`input#usuario`), modal de unidade (`modal-login-multiunidade`) ou sessão ativa (`button#atalhoNovoCadastro`). Só faz login se precisar. É o entrypoint que o bridge usa; o CLI chama `login` + `escolherUnidade` separados.
2. **`escolherUnidade`** — `marcarUnidade` faz matching por score F1 de palavras contra os cards do modal (procurando em `modal-login-multiunidade`, `mat-dialog-container` e `.cdk-overlay-container`), marca o alvo com `data-evo-target` e clica; pode haver botão de confirmação (entrar/confirmar/acessar/selecionar/continuar). Nome ambíguo ou sem match lança erro listando as opções visíveis.
3. **`abrirNovoCadastro`** — clica `button#atalhoNovoCadastro` e espera `evo-drawer#cadastroDrawer input#nome`.
4. **`preencherCadastro`** — dentro do drawer: `input#nome` (único obrigatório), `input#snome`, `input#cpf`, `input#dtNascimento`, `mat-select#sexo`, `input#cep`, DDI e telefone dentro de `evo-phone`, `input#email`, `mat-select#tipoVisita`, `mat-select#prospectMarketing` (múltipla escolha, fecha com Escape). Campos vazios são pulados.
5. **`conferirCadastro`** — relê os campos e devolve `Record<string, string>`.

**Nada é salvo.** Não existe clique em salvar/submeter em lugar nenhum — o formulário fica preenchido e o Chrome aberto para a recepção revisar e salvar à mão. Isso é requisito de produto, não pendência.

## Payload

```typescript
type Prospect = {
  nome: string;          // obrigatório
  sobrenome?: string;
  cpf?: string;
  nascimento?: string;   // "01/04/1994"
  genero?: string;       // "Masculino"
  cep?: string;
  ddi?: string;          // só dígitos, sem "+"
  telefone?: string;     // DDD + número
  email?: string;
  tipoVisita?: string;
  comoConheceu?: string;
};
```

O bridge envolve isso em `{ credenciais: { usuario, senha }, unidade, prospect }`, montado pelo back em `GET /api/evo/attendances/:id/payload`.

## Launch do Chrome

O bridge (`evo-bridge/src/browser.ts`) é quem lança na prática: headed, `executablePath` resolvido por `chrome.ts`, `userDataDir` por usuário EVO (perfil persistente, então a sessão do EVO sobrevive entre jobs), `defaultViewport: null`, `--start-maximized`, e reconexão via `DevToolsActivePort` quando já há Chrome do perfil rodando.

O CLI lança por conta própria e **não define `executablePath` nem `userDataDir`** — perfil efêmero e, no Windows, provável falha de launch sem configuração extra. Se você for consertar algo aqui, reaproveite a resolução de `evo-bridge/src/chrome.ts`.

## CLI

Flags: `--usuario`, `--senha` (ou `EVO_USUARIO`/`EVO_SENHA`), `--unidade`, `--nome`, `--sobrenome`, `--cpf`, `--nascimento`, `--genero`, `--cep`, `--ddi`, `--telefone`, `--email`, `--tipo-visita`, `--como-conheceu`, `--timeout`, `--slow-mo`, `--headless`, `--fechar`, `--help`. Sem `--fechar` o navegador fica aberto até Ctrl+C.

O texto de `--help` diz que o timeout padrão é 30000, mas o código usa `120_000`.

`EVO_USUARIO` e `EVO_SENHA` são as únicas env vars lidas (o Bun carrega `.env` sozinho). O `.env.example` foi deletado no commit `f3581a2` e continha só essas duas chaves; o `README.md` ainda manda copiá-lo.

## Fragilidade e retries

`dom.ts` faz polling de 120ms com fatias de espera de 5s. Cliques checam estabilidade (dois frames com o mesmo rect) e se o elemento está no topo, com fallback para clique via DOM. `fill` digita rápido e repete devagar (40ms) se a máscara não bater; `fillMasked` tenta de novo só com dígitos. `selectMatOption` abre o painel `#${id}-panel` e casa o texto de forma difusa. Erros transitórios (nó destacado, navegação) são reconhecidos e repetidos até o deadline. O bridge ainda tem `abrirNovoCadastroComRetry`, que refaz a sessão se o login reaparecer no meio do fluxo.

Pontos que quebram com facilidade:

- IDs fixos e estrutura do Angular Material — qualquer redesign do EVO invalida os seletores.
- Nomes de unidade dependem do matching por texto; unidades com nomes parecidos lançam ambiguidade.
- Rótulos de "como conheceu" variam em acento e pontuação, daí o `textoCorresponde` difuso.
- O DDI casa por dígito exato de propósito (senão `+55` bate dentro de `+355`).
- Depois do CEP há um `sleep` de 1s obrigatório: o EVO repinta os campos de endereço e escrever antes disso perde o valor.

Erros lançam `Error` com mensagem em português. O CLI captura, grava `screenshots/erro-{timestamp}.png` e sai com código 1; o bridge grava em `EVO_SCREENSHOTS_DIR` e guarda o caminho no job.
