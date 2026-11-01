# evo-payment-checker — conferência diária de pagamentos no EVO

Job em lote (Cloud Run Job, todo dia às **01:00 America/Sao_Paulo**) que confere se as vendas lançadas no tracker foram realmente pagas no EVO e atualiza `sales.payment_status`. O dashboard só soma vendas `PAGO`.

Contexto do monorepo: [`../gym-conversion-tracker-workspace/AGENTS.md`](../gym-conversion-tracker-workspace/AGENTS.md).

## Comandos

| Comando | O que faz |
|---------|-----------|
| `bun run start` | Roda a conferência (grava no banco) |
| `bun run dry-run` | Mesma conferência, só imprime as decisões |
| `bun src/check.ts --include-today --dry-run` | Teste local: inclui vendas de hoje (o Chrome abre com janela) |
| `bun src/check.ts --sale <uuid>` | Confere uma venda específica |
| `bun run typecheck` / `bun test` | `tsc --noEmit` / testes de `src/matching.ts` |
| `.\deploy.ps1 [-RunNow] [-SkipBuild]` | Build + push + Cloud Run Job + Cloud Scheduler |
| `.\ship.ps1` (ou duplo clique em `ship-local.cmd` / `ship-job.cmd`) | Migration + deploy back/front + dry-run local + job; log em `logs/` |

Local: copie `.env.example` para `.env` com os mesmos `Postgre*` e `EVO_CRED_KEY` do `back/.env`.

## Status (`sale_payment_status`, migration `back/drizzle/0010_sale_payment_status.sql`)

| Status | Quando | Soma no dashboard |
|--------|--------|-------------------|
| `A_CONFERIR` | Default de toda venda nova; conferida na madrugada seguinte | não |
| `PAGO` | Achou venda no EVO com `valorPago > 0` (ou contrato zero ↔ venda zero) | **sim** |
| `PAGAMENTO_PENDENTE` | Não achou cliente/venda paga; reconferida todo dia | não |
| `NAO_PAGO` | Pendente há mais de `PAYMENT_PENDING_MAX_DAYS` (30) dias; não é mais conferida | não |

Seleção a cada rodada: `A_CONFERIR` criadas antes de hoje (fuso da academia) + todas as `PAGAMENTO_PENDENTE`. A primeira rodada após a migration confere o histórico inteiro.

## Fluxo

1. Lê as credenciais EVO do usuário `EVO_CHECKER_USER_EMAIL` (default `lrsperanza@gmail.com`; hoje é o login EVO `ericles-carvalho@hotmail.com` + 2FA), decifradas com `EVO_CRED_KEY` — mesmas colunas que o back usa em `users`.
2. Agrupa as vendas por `academies.evo_unit_name`. Para cada unidade abre um contexto anônimo do Chromium e faz login com `garantirSessao` do `evo-puppeteer` (usuário, senha, TOTP, modal de unidade). Logins seguidos esperam a próxima janela de 30s do TOTP.
3. Captura os headers que o SPA manda para `evo-abc-api.w12app.com.br` (`Authorization`, `DNS`, `Filial`, `chaveIdFilial`, `chaveIdW12`, `idW12`) e chama a API **de dentro da página** (`page.evaluate(fetch)`):
   - `GET /api/v1/clientes/basicos?pesquisa=…` — mesma busca da barra do topo; aceita CPF, e-mail, nome ou ID. **Não acha por telefone.**
   - `POST evo3.w12app.com.br/Gerencial/Vendas/listarVendas` — grid do relatório Gerencial › Vendas (tipo Contrato, período da venda mais antiga até hoje). Uma chamada por unidade; traz `ID_COMPRADOR`, `NOME_COMPRADOR`/`APELIDO`, `NOME_FUNCIONARIO_VENDA` ("colaborador venda"), `VALOR_VENDA`, `FORMA_PAGAMENTO`. Exige abrir a tela via iframe SSO do EVO 5 (`LogarEvo3?TokenEvo3=…`) e mandar o `__RequestVerificationToken` da página.
   - `POST /api/v1/venda/historico-vendas-cliente` — aba "Vendas" do perfil; traz `valorVenda`, `valorPago`, `valorPagar` e `recebimentos[]` (`dsStatusRecebimento: "Pago"`). Exige `idCliente`; sem ele volta vazio.
4. `src/matching.ts` decide (puro, testado): CPF → e-mail → relatório Gerencial › Vendas (`reportCandidates`: nome completo do lead dentro de `NOME_COMPRADOR + APELIDO`, ou só o primeiro nome com o mesmo colaborador da venda no mesmo dia) → nome (todos os tokens do nome do lead no nome do EVO; nome de um token só exige telefone; telefone desempata homônimos). Venda EVO aceita de `PAYMENT_LOOKBACK_DAYS` (20 — renovações chegam a ser lançadas no tracker 2 semanas depois; menor que o ciclo mensal de 30 dias) antes até `PAYMENT_FORWARD_DAYS` (7) depois do lançamento — depois disso já é outra compra (renovação); escolhe a paga mais próxima da data. Cada `idVenda` do EVO confirma no máximo uma venda do tracker (índice único `sales_evo_sale_id_idx`).
5. Grava `payment_status`, `payment_checked_at`, `payment_check_count`, `payment_check_note` (motivo legível, mostrado no tooltip do dashboard), `evo_client_id`, `evo_sale_id`, `evo_paid_cents`, `evo_sold_at` (`dtVenda` da venda do EVO; o dashboard soma receita por essa data — migration `back/drizzle/0011_sale_evo_sold_at.sql`, com backfill pela nota).

Falha de login numa unidade não mexe nas vendas dela (voltam no dia seguinte) e o processo sai com código 1, o que marca a execução como falha no Cloud Run. Erro numa venda isolada também mantém o status.

## Permissões do usuário EVO

O usuário é de recepção: telas gerenciais (Movimentação Financeira, relatórios novos) dão "não autorizado". Por isso a conferência é por cliente, não por relatório do dia. Se as permissões mudarem, `api/v2/caixa/caixas` e os relatórios gerenciais podem virar fonte alternativa.

## Cloudflare e Cloud Run (lições do primeiro deploy)

- O EVO (`*.w12app.com.br`) fica atrás do Cloudflare, que responde "Sorry, you have been blocked" para Chrome headless. O Chrome roda **com janela**: localmente abre uma janela normal; no container roda num Xvfb iniciado por `entrypoint.sh`. `launchBrowser` ainda troca `HeadlessChrome` por `Chrome` na user-agent e desliga `--enable-automation`/`AutomationControlled`.
- **Não use `xvfb-run`** no Cloud Run: ele travou o container sem nenhuma linha de log por 30+ minutos. O `entrypoint.sh` sobe o `Xvfb :99` direto e loga cada passo.
- No container, depois do 2FA o SPA vai para `#/app/<dns>/<filial>/inicio/geral` mas fica em "Carregando" e não chama a API (o botão `#atalhoNovoCadastro`, que o `evo-puppeteer` usa para reconhecer a sessão, nunca aparece). Por isso `EvoSession.login`:
  1. aceita a URL da área logada como sucesso mesmo se `garantirSessao` reclamar;
  2. se nenhuma chamada da tela for observada, monta os headers a partir do storage do EVO: `localStorage['evo.authToken']` (Bearer), `localStorage['evo.DNS']`, `sessionStorage['evo.idFilialAtivo']`, e de `evo.user`: `idFilialCripto` → `chaveIdFilial`, `idW12Cripto` → `chaveIdW12`, `idW12`;
  3. valida com `GET /api/v1/auth/logado` antes de seguir.
- O relatório do EVO 3 é aberto direto em `https://evo3.w12app.com.br/Login/LogarEvo3?TokenEvo3=<localStorage['evo.tokenEvo3'], já url-encoded>&idFilial=<filial>&redirectToView=Index/VENDAS&redirectToController=Gerencial&redirectToArea=Gerencial` (fallback: iframe da tela do EVO 5). A cada chamada a `listarVendas` o token anti-forgery é relido de um `GET /Gerencial/Gerencial/Index/VENDAS` — reaproveitar o token da página dá "anti-forgery cookie token and form field token do not match" quando o iframe reabre o EVO 3.
- Durante o login o job registra a tela a cada mudança (`[evo] tela: …`) e, com `EVO_LOG_SCREENSHOTS=true` (padrão no container), o screenshot de erro vai em base64 para o log (`[evo] screenshot-b64 …`).

## Operação (Windows, sem terminal)

Atalhos `.cmd` para duplo clique na pasta; todos gravam em `logs/` (UTF-8):

| Atalho | O que faz |
|--------|-----------|
| `ship-local.cmd` | Dry-run local (Chrome com janela), não grava |
| `ship-job.cmd` | Build + publica o job **em dry-run** (`CHECK_DRY_RUN=true`) e executa no Cloud Run |
| `ship-job-real.cmd` | Republica o job sem dry-run (imagem `:latest`) e executa de verdade |
| `job-logs.cmd` | Baixa os logs recentes do job para `logs/job-*.log` |
| `job-cancel.cmd` | Cancela a execução mais recente e baixa os logs |

Atenção: depois de `ship-job.cmd` o job **fica em dry-run** (inclusive na execução das 01:00) até rodar `ship-job-real.cmd` ou `deploy.ps1` sem `-DryRunNow`. O `gcloud` desta máquina não aceita `--update-env-vars` em `jobs execute` (erro `priorityTier`), por isso o dry-run é uma variável do próprio job.

O serviço do back não define `PostgreDatabase`/`PostgreUser`/`PostgrePort`; o deploy só copia o que existe (o job usa os mesmos defaults do back).

## Container

`Dockerfile` usa `oven/bun:1-debian` + `chromium` + `xvfb` do apt, `ENTRYPOINT entrypoint.sh`, build com contexto na **raiz do monorepo** (`docker build -f evo-payment-checker/Dockerfile .`); `Dockerfile.dockerignore` restringe o contexto. A execução completa (~410 vendas) leva ~15 min no Cloud Run, sendo ~3 min de login (a detecção do `evo-puppeteer` espera o atalho da home até desistir).

`deploy.ps1` copia `Postgre*` e `EVO_CRED_KEY` do serviço `gym-conversion-tracker` (valor ou referência ao Secret Manager), usa a mesma service account, concede `roles/run.invoker` no job e cria/atualiza o Cloud Scheduler `evo-payment-checker-daily` com `POST …/jobs/evo-payment-checker:run`.

## Pontos frágeis

- API interna do EVO, não documentada: mudança de rota/payload quebra a conferência (o job falha alto, não marca nada errado).
- Leads sem CPF/e-mail dependem do nome. Nome digitado diferente no EVO → fica pendente, com a nota "Cliente não encontrado".
- `dtVenda` vem sem fuso; assumimos `-03:00`.
- Lançamentos duplicados do mesmo aluno no tracker: o primeiro leva a venda do EVO, o outro fica pendente/não pago ("vendas no EVO já usadas por outros lançamentos").
