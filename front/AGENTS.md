# front — SPA SvelteKit

SPA 100% cliente (SvelteKit 5 + Svelte runes + Tailwind 4), em pt-BR. Telas de recepção, leads, dashboard, administração e conta. Deploy em Azure Static Web Apps; localmente pode ser servida através do `evo-bridge`.

Contexto do monorepo: [`../gym-conversion-tracker-workspace/AGENTS.md`](../gym-conversion-tracker-workspace/AGENTS.md).

## Comandos

| Comando | O que faz |
|---------|-----------|
| `bun run dev` | Vite em `:5173` |
| `bun run build` | Saída estática em `build/` |
| `bun run preview` | Serve o build em `:4173` (é o que o Playwright usa) |
| `bun run check` | `svelte-kit sync && svelte-check` |
| `bun run lint` / `bun run format` | Prettier (não há ESLint) |
| `bun run test:unit -- --run` | Vitest sem watch |
| `bun run test:e2e` | Playwright (`**/*.e2e.ts`) |

## Arquitetura

**Não existe `svelte.config.js`.** O adapter fica em `vite.config.ts`: `adapter-static` com `fallback: 'index.html'`. Isso pega agentes de surpresa — procure config de SvelteKit no Vite.

`src/routes/+layout.ts` define `ssr = false` e `prerender = true`. Não há `+server.ts` nem `hooks.*.ts`: nenhum código roda em servidor, tudo é build estático + hidratação.

O compilador Svelte é forçado com `runes: true` para todo código fora de `node_modules`. `envPrefix` aceita `VITE_` e `PUBLIC_`, mas só `PUBLIC_*` é usado.

Vitest tem dois projetos: `client` (browser, Chromium via Playwright, casa `src/**/*.svelte.{test,spec}.ts`) e `server` (Node, o resto). `expect.requireAssertions` está ligado. Hoje só existem testes Node (`src/lib/api/client.spec.ts`, `src/lib/helpers.spec.ts`) — o projeto de browser está configurado e vazio.

## Rotas

| Rota | O quê |
|------|-------|
| `/` | `+page.ts` redireciona para `/atendimento` |
| `/atendimento` | Tela principal da recepção: abertura rápida de atendimento, fila visual, edição inline, modal de eventos, criação de professor. Repolla a fila a cada 30s |
| `/leads` | Agendados próximos + busca de leads, via `LeadRow` |
| `/dashboard` | KPIs, timeline, tabelas de métricas, auditoria. Gated: ADMIN, SOCIO, GERENTE_REGIONAL |
| `/administracao` | CRUD de academias, usuários, professores, planos e motivos de perda. Gated: os três acima + LIDER |
| `/conta` | Senha, confirmação de e-mail, credenciais EVO, sessão do navegador EVO |
| `/redefinir-senha` | Pública (`?token=`), única entrada em `PUBLIC_ROUTES` |

Não há rota `/login`: o formulário vive no `+layout.svelte` raiz quando `session.user` é nulo. Guards são client-side, no `onMount` de cada página, usando os helpers de `src/lib/auth/roles.ts` (`canAccessDashboard`, `canAccessAdmin`).

## Dois clientes HTTP

Essa é a parte mais fácil de errar: existem **duas** resoluções de host independentes.

**`src/lib/api/client.ts`** — a API de domínio. `api<T>(path, options)` sempre com `credentials: 'include'` (sessão por cookie, sem Bearer) e erros como `ApiError` com `status` e a mensagem de `payload.error.message`. O host vem de `src/lib/api/hosts.ts`, nesta ordem: override manual em `localStorage['skyfit:api-host']` → se o bridge estiver na mesma origem, string vazia (ou seja, `/api` relativo pelo proxy do bridge) → `PUBLIC_API_URL`. O seletor escondido de host é Ctrl+D (`ApiHostBadge.svelte`) e **só vale após reload**. A checagem de saúde é `GET {host}/api/check-connection` esperando `service: 'gym-conversion-tracker-back'`.

**`src/lib/api/bridge.ts` + `evo.ts`** — o bridge local. `getBridgeBaseUrl()` sonda `GET /evo/health` na mesma origem e, se falhar, em `PUBLIC_EVO_URL` (default `http://localhost:4000`). Chamadas a loopback usam `targetAddressSpace: 'loopback'` por causa do Private Network Access do Chrome. Endpoints consumidos: `/evo/health`, `/evo/venda`, `/evo/status/:jobId`, `/evo/perfil`, `/evo/app-info`, `/evo/apply-update`.

Detectar o bridge na mesma origem **também** muda a API para relativa. Ao mexer em um dos dois, verifique o efeito no outro.

## Fluxo de venda EVO

Em `EventFormModal.svelte`: grava o evento pela API → pede `POST /api/evo/attendances/:id/ticket` → chama `POST /evo/venda` no bridge com `{ attendanceId, ticket }` → faz polling de `/evo/status/:jobId`. A venda pode ser registrada com sucesso no tracker e falhar no EVO; a UI trata isso com aviso e opção de repetir, não como erro fatal. Front em HTTPS com bridge em HTTP é mixed content e bloqueia tudo — por isso o app desktop serve de `http://localhost:4000`.

`src/lib/api/evo-log.svelte.ts` é um store de runes em módulo (`$state`) persistido em `skyfit:evo-log`, exibido por `EvoBridgeDiagnostics.svelte`.

## Estado

Runes em tudo: `$state`, `$state.raw` para coleções trocadas por inteiro, `$derived`/`$derived.by`, `$effect`, `$props`. Sessão global no `+layout.svelte` raiz, distribuída por `createContext` em `src/lib/session.ts` (`getSessionContext`/`setSessionContext`, com `loadSession`/`logout`). Não há biblioteca de store nem writables clássicos.

Chaves de `localStorage`: `skyfit:api-host`, `skyfit:evo-log`, `attendance-quick-draft`.

## Tipos

`src/lib/types.ts` espelha `back/src/db/schema.ts` **à mão** — não há pacote compartilhado. Mudou o schema no back? Atualize aqui. Contém `Role`, `User`, `Academy`, `Professor`, `AttendanceEventType`, `LeadEvent`, `Attendance`, `LeadSummary`, `OutcomeType`, `LossReason`, `EvoCredentialsStatus`, `EvoJobStatus`, `DashboardSummary`, `MetricRow`.

## UI

Sem biblioteca de componentes (nada de shadcn-svelte, bits-ui, lucide). Componentes próprios em `src/lib/components/`, PascalCase, modais com sufixo `FormModal` usando `<dialog>` nativo. Tema claro fixo (slate + acento sky-600, tokens em `src/routes/layout.css`), sem dark mode; ícones são SVG inline. Padrão de card: `rounded-3xl bg-white … ring-1 ring-slate-200`.

Formulários são `<form onsubmit={...}>` nativos com `preventDefault()` e validação inline; nenhuma lib de forms.

## Formatação e domínio no cliente

pt-BR fixo, sem i18n. `dateTime()` usa `America/Sao_Paulo`. Valores trafegam em **centavos**: exiba com `money()` e converta entrada com `asCents()` (vírgula decimal). `parsePhone()` quebra em `{ countryCode, areaCode, number }` para a API. `isQueueVisible()` esconde atendimentos `PENDING` até 15 min antes de `next_scheduled_for`. A opção `__new__` no select de professor abre o `ProfessorFormModal`.

## Env e deploy

`PUBLIC_API_URL` (default `http://localhost:3000`), `PUBLIC_EVO_URL` (default `http://localhost:4000`), `PUBLIC_API_HOSTS` (extras para o Ctrl+D, separados por vírgula).

`build/` é consumido pelo Azure SWA. Deploy por `deploy.ps1` (`bun run build` + `swa deploy`, config `swa-cli.config.json`) — **não há GitHub Actions**. Não existe `staticwebapp.config.json`; o roteamento SPA vem do `fallback: 'index.html'`.

Para servir por trás do bridge, o build precisa de `PUBLIC_API_URL=/` (é o que o `run-all.ps1 -Build` faz). Note que o `evo-bridge` atual faz proxy de `FRONT_URL` pela rede e não lê `front/build` do disco, apesar de o `run-all.ps1` ainda exigir que esse build exista.

---

## Project Configuration

- **Language**: TypeScript
- **Package Manager**: bun
- **Add-ons**: prettier, vitest, playwright, tailwindcss, sveltekit-adapter, mcp

---

You are able to use the Svelte MCP server, where you have access to comprehensive Svelte 5 and SvelteKit documentation. Here's how to use the available tools effectively:

## Available Svelte MCP Tools:

### 1. list-sections

Use this FIRST to discover all available documentation sections. Returns a structured list with titles, use_cases, and paths.
When asked about Svelte or SvelteKit topics, ALWAYS use this tool at the start of the chat to find relevant sections.

### 2. get-documentation

Retrieves full documentation content for specific sections. Accepts single or multiple sections.
After calling the list-sections tool, you MUST analyze the returned documentation sections (especially the use_cases field) and then use the get-documentation tool to fetch ALL documentation sections that are relevant for the user's task.

### 3. svelte-autofixer

Analyzes Svelte code and returns issues and suggestions.
You MUST use this tool whenever writing Svelte code before sending it to the user. Keep calling it until no issues or suggestions are returned.

### 4. playground-link

Generates a Svelte Playground link with the provided code.
After completing the code, ask the user if they want a playground link. Only call this tool after user confirmation and NEVER if code was written to files in their project.
