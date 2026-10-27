# evo-payment-checker — conferência diária de pagamentos no EVO

Job em lote (Cloud Run Job, todo dia às **01:00 America/Sao_Paulo**) que confere se as vendas lançadas no tracker foram realmente pagas no EVO e atualiza `sales.payment_status`. O dashboard só soma vendas `PAGO`.

Contexto do monorepo: [`../gym-conversion-tracker-workspace/AGENTS.md`](../gym-conversion-tracker-workspace/AGENTS.md).

## Comandos

| Comando | O que faz |
|---------|-----------|
| `bun run start` | Roda a conferência (grava no banco) |
| `bun run dry-run` | Mesma conferência, só imprime as decisões |
| `bun src/check.ts --include-today --headed --dry-run` | Teste local: inclui vendas de hoje e abre o Chrome visível |
| `bun src/check.ts --sale <uuid>` | Confere uma venda específica |
| `bun run typecheck` / `bun test` | `tsc --noEmit` / testes de `src/matching.ts` |
| `.\deploy.ps1 [-RunNow] [-SkipBuild]` | Build + push + Cloud Run Job + Cloud Scheduler |

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
   - `POST /api/v1/venda/historico-vendas-cliente` — aba "Vendas" do perfil; traz `valorVenda`, `valorPago`, `valorPagar` e `recebimentos[]` (`dsStatusRecebimento: "Pago"`). Exige `idCliente`; sem ele volta vazio.
4. `src/matching.ts` decide (puro, testado): CPF → e-mail → nome (todos os tokens do nome do lead no nome do EVO; nome de um token só exige telefone; telefone desempata homônimos). Venda EVO aceita a partir de `PAYMENT_LOOKBACK_DAYS` (2) antes do lançamento; escolhe a paga mais próxima da data. Cada `idVenda` do EVO confirma no máximo uma venda do tracker (índice único `sales_evo_sale_id_idx`).
5. Grava `payment_status`, `payment_checked_at`, `payment_check_count`, `payment_check_note` (motivo legível, mostrado no tooltip do dashboard), `evo_client_id`, `evo_sale_id`, `evo_paid_cents`.

Falha de login numa unidade não mexe nas vendas dela (voltam no dia seguinte) e o processo sai com código 1, o que marca a execução como falha no Cloud Run. Erro numa venda isolada também mantém o status.

## Permissões do usuário EVO

O usuário é de recepção: telas gerenciais (Movimentação Financeira, relatórios novos) dão "não autorizado". Por isso a conferência é por cliente, não por relatório do dia. Se as permissões mudarem, `api/v2/caixa/caixas` e os relatórios gerenciais podem virar fonte alternativa.

## Container

`Dockerfile` usa `oven/bun:1-debian` + `chromium` do apt, build com contexto na **raiz do monorepo** (`docker build -f evo-payment-checker/Dockerfile .`); `Dockerfile.dockerignore` restringe o contexto. Ainda não há `bun.lock` — rode `bun install` aqui uma vez e commite o lock.

`deploy.ps1` copia `Postgre*` e `EVO_CRED_KEY` do serviço `gym-conversion-tracker` (valor ou referência ao Secret Manager), usa a mesma service account, concede `roles/run.invoker` no job e cria/atualiza o Cloud Scheduler `evo-payment-checker-daily` com `POST …/jobs/evo-payment-checker:run`.

## Pontos frágeis

- API interna do EVO, não documentada: mudança de rota/payload quebra a conferência (o job falha alto, não marca nada errado).
- Leads sem CPF/e-mail dependem do nome. Nome digitado diferente no EVO → fica pendente, com a nota "Cliente não encontrado".
- `dtVenda` vem sem fuso; assumimos `-03:00`.
