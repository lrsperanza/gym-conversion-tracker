# back — API de domínio

Hono sobre `Bun.serve`. Fonte da verdade do domínio (atendimentos, leads, vendas, métricas) e do schema Postgres. Deploy em GCP Cloud Run.

Contexto do monorepo: [`../gym-conversion-tracker-workspace/AGENTS.md`](../gym-conversion-tracker-workspace/AGENTS.md).

## Comandos

| Comando | O que faz |
|---------|-----------|
| `bun run dev` | `bun --watch src/index.ts` → `:3000` |
| `bun run start` | Sem watch (usado em produção/Docker) |
| `bun run check` | `tsc --noEmit` — **único gate de qualidade**, não há ESLint/Prettier aqui |
| `bun test` | Testes (`bun:test`). Arquivo único: `bun test src/domain/normalize.test.ts` |
| `bun run db:migrate` | Aplica `drizzle/*.sql` em ordem de nome |
| `bun run db:seed` | Upsert de outcome types + loss reasons padrão |
| `bun run bootstrap:admin "Nome" email senha [whatsapp]` | Cria o primeiro ADMIN global |
| `bun run desktop:publish <caminho.exe>` | Sobe build do desktop para o Azure Blob |

Bootstrap do zero: `.env` → `db:migrate` → `db:seed` → `bootstrap:admin` → `dev`.

## Layout

| Pasta | Conteúdo |
|-------|----------|
| `src/index.ts` | Montagem do Hono, CORS, `/health`, `/api/check-connection`, `openapi.json`, `Bun.serve` |
| `src/config/env.ts` | Env parseado com Zod + constante `DB_SCHEMA` |
| `src/db/` | `client.ts` (postgres.js), `schema.ts` (canônico), `migrate.ts`, `seed.ts` |
| `src/domain/` | `normalize.ts` (nome/email/telefone), `outcomeTypeKey.ts` + testes |
| `src/http/` | `auth.ts` (middleware + RBAC), `errors.ts`, `schemas.ts` (Zod), `types.ts` |
| `src/routes/` | `auth.ts`, `admin.ts`, `attendances.ts`, `dashboard.ts`, `evo.ts`, `desktop.ts` |
| `src/security/` | `crypto.ts`, `evoCrypto.ts` (AES-GCM), `evoTicket.ts` (HMAC) |
| `src/services/` | `audit.ts`, `azureBlob.ts`, `emailTokens.ts`, `mail.ts` |
| `src/scripts/` | `bootstrap-admin.ts`, `publish-desktop.ts` |
| `drizzle/` | Migrations `.sql` numeradas |

## Banco

**Postgres**, schema **`"gym-conversion-tracker"`** (nunca `public`). Extensões exigidas: `pgcrypto`, `pg_trgm`.

**Regra mais importante do repo:** Drizzle é usado **só para definir schema e tipos**. Todo acesso em runtime usa a tag `sql` de `src/db/client.ts` com SQL cru, sempre qualificando `"gym-conversion-tracker"."tabela"`. O export `db` (drizzle) existe mas não é usado em lugar nenhum — não introduza query builder em handler novo, siga o estilo vizinho.

Tabelas: `academies`, `users`, `user_academy_roles`, `professors`, `leads`, `attendances`, `attendance_events`, `outcome_types`, `sales`, `loss_reasons`, `attendance_losses`, `sessions`, `email_tokens`, `audit_logs`, além de `_migrations` (criada pelo runner, fora do schema Drizzle).

Enums: `role`, `attendance_status`, `presenter`, `attendance_event_type`, `outcome_kind`, `loss_category`, `email_token_purpose`.

Migrations rodam uma vez cada, em transação, registradas em `_migrations`. Não há script de `drizzle-kit generate` no `package.json`; as migrations existentes misturam SQL gerado e escrito à mão.

## HTTP

Montagem em `src/index.ts`:

```typescript
app.route('/api/auth', authRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/evo', evoRoutes);
app.route('/api/desktop', desktopRoutes);
app.route('/api', attendanceRoutes);   // leads + attendances
app.route('/api', dashboardRoutes);
```

`/health` e `/api/check-connection` são públicos (o front usa `check-connection` para detectar host — a resposta precisa manter `service: 'gym-conversion-tracker-back'`). `/api/desktop/*` também é público, sem auth.

**Erros:** lance `AppError` ou os helpers `badRequest`/`unauthorized`/`forbidden`/`notFound`/`conflict` de `src/http/errors.ts`. O `app.onError(handleError)` traduz para `{ error: { code, message, details? } }`; `ZodError` vira 422 `VALIDATION_ERROR`, erro de conexão vira 503 `DB_UNAVAILABLE`.

**Sucesso:** não existe envelope. Cada handler devolve JSON próprio (`{ ok: true }`, `{ academies: [...] }`, `{ attendance, events, sales, losses }`).

O `openapi.json` embutido em `index.ts` é um stub incompleto — não é fonte da verdade.

## Auth e RBAC

Sessão por cookie **`gct_session`** (HttpOnly, 14 dias). O token cru fica no cliente; o banco guarda SHA-256 em `sessions.token_hash`. `Secure` + `SameSite=None` quando `x-forwarded-proto` é https, senão `SameSite=Lax`.

Roles: `ADMIN`, `SOCIO`, `GERENTE_REGIONAL`, `LIDER`, `RECEPCIONISTA`, atribuídos em `user_academy_roles`. `academy_id = null` significa role global.

Helpers em `src/http/auth.ts`: `requireAuth`, `requireAnyRole`, `hasGlobalRole`, `canAccessAcademy` / `assertCanAccessAcademy`, `canManageUserRole`, `canManageProfessor`. **Todo endpoint de listagem novo precisa de escopo por academia** — esquecer isso é o bug de segurança mais fácil de cometer aqui.

CORS declara só `allowHeaders: ['Content-Type']`; auth é por cookie. A única rota que aceita `Authorization` é o payload do EVO.

## EVO

Credenciais são por usuário: `users.evo_username` + `users.evo_password_encrypted` (AES-256-GCM com `EVO_CRED_KEY`). `GET /api/evo/credentials` nunca devolve a senha.

**Ticket** (`src/security/evoTicket.ts`): `POST /api/evo/attendances/:id/ticket` devolve `<payload-base64url>.<hmac>` com TTL de 5 min, assinado com `EVO_TICKET_KEY` (cai em `EVO_CRED_KEY` se ausente) e vinculado a `attendanceId` + `userId`. Existe porque o front pode estar em HTTPS remoto enquanto o bridge é HTTP local — o bridge autentica no back sem cookie.

`GET /api/evo/attendances/:id/payload` aceita cookie **ou** `Bearer <ticket>` e devolve `{ credenciais: { usuario, senha }, unidade, prospect }`. **Esse endpoint retorna a senha do EVO em texto claro** — é intencional (consumo local pelo bridge), mas trate qualquer mudança nele como mexer em superfície sensível. Falta de nome do lead ou de credenciais → 422 `EVO_INCOMPLETE` com `details`. O telefone vai como DDD+número (não E.164) por causa da máscara do formulário do EVO.

O back não fala com o EVO por HTTP; a automação é do `evo-bridge` + `evo-puppeteer`.

## Integrações

- **Azure Blob** (`src/services/azureBlob.ts`): distribuição do desktop. REST puro com assinatura Shared Key/SAS, sem SDK. `listBlobs`, `blobDownloadUrl`, `uploadBlob`. Blobs nomeados `{DESKTOP_BUILD_PREFIX}{semver}.exe`.
- **SMTP AWS SES** via Nodemailer (`src/services/mail.ts`). Sem `AWS_SMTP_FROM_EMAIL` o envio lança 503.
- **Cloud Run** para deploy. Nenhum outro SDK GCP no código.

## Env

Tudo é lido em `src/config/env.ts` (Zod, a partir de `Bun.env`):

`PostgreHost`, `PostgrePort`, `PostgreDatabase`, `PostgreUser`, `PostgrePassword`, `PostgreSSL`, `PORT`, `API_PORT`, `CORS_ORIGIN`, `APP_URL`, `AWS_SMTP_HOST`, `AWS_SMTP_PORT`, `AWS_SMTP_USERNAME`, `AWS_SMTP_PASSWORD`, `AWS_SMTP_FROM_EMAIL`, `AWS_SMTP_FROM_NAME`, `EVO_CRED_KEY` (base64 de 32 bytes), `EVO_TICKET_KEY`, `AZURE_STORAGE_ACCOUNT_NAME`, `AZURE_STORAGE_ACCOUNT_KEY`, `DESKTOP_BLOB_CONTAINER`, `DESKTOP_BUILD_PREFIX`.

`PORT` (injetado pelo Cloud Run) tem prioridade sobre `API_PORT`. `DB_SCHEMA` é constante, não env. O `.env.example` está incompleto: faltam `PostgreSSL`, `PORT` e `EVO_TICKET_KEY`.

## Deploy

`Dockerfile` (`oven/bun:1-alpine`, expõe 8080) + `deploy.ps1`: build para o Artifact Registry `southamerica-east1` e `gcloud run deploy` do serviço `gym-conversion-tracker` (512Mi, 1 CPU, concorrência 80, `--allow-unauthenticated`). URL: `https://gym-conversion-tracker-437354431924.southamerica-east1.run.app`.

`deploy.ps1` só passa `CORS_ORIGIN` e `APP_URL`; **segredos de DB/SMTP/EVO/Azure precisam já estar configurados no serviço do Cloud Run**. Não há CI — o deploy é manual.

## Invariantes do domínio

- **Dinheiro é inteiro em centavos** (`amount_cents`, `current_value_cents`). `sales` guarda `label_snapshot` + valor no fechamento; editar o preço de um `outcome_type` não reescreve histórico.
- **`attendance_events` é append-only** — não existe rota de update/delete.
- **Soft delete é flag `active`**, não `deleted_at`. Troca de role desativa as linhas antigas e insere novas.
- `started_at` é definido pelo servidor no create; não há como retroagir por API.
- `presenter = 'PROFESSOR'` exige `professorId`.
- A lista de atendimentos esconde `FINALIZED` por padrão, a menos que venha `?status=`.
- Cancelamento de agendamento é um evento `SCHEDULE_CANCELLED` posterior (ordenado por `created_at`), não a remoção do agendamento.
- Busca por nome usa `pg_trgm` (`normalized_name % query`, `similarity()`); duplicatas usam `whatsapp_e164`/`email` normalizados.
- Telefone assume Brasil `55` e DDD `16` quando omitido (`normalizePhone`).
- Timestamps são `timestamptz`; agregações do dashboard usam `AT TIME ZONE 'America/Sao_Paulo'`.
- Chaves de outcome type são geradas pelo servidor (`sale_<uuid>` via `createWithUniqueOutcomeTypeKey`), nunca pelo cliente.
- Ações de auditoria são strings pontuadas (`auth.login`, `attendance.create`).
- `LEAD_CREATED` existe no enum mas nenhuma rota o insere; a abertura grava `TOUR_RECEPTIONIST`/`TOUR_PROFESSOR`.
- O dashboard exclui `LIDER` (só ADMIN/SOCIO/GERENTE_REGIONAL), embora `LIDER` acesse administração.
