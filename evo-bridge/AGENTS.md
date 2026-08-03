# evo-bridge — proxy same-origin + runner de jobs EVO

Servidor Hono/Bun em `127.0.0.1:4000`. Faz duas coisas: dá ao front uma origem única (proxy de `/api` para o back e de todo o resto para o front) e roda a automação do EVO chamando `evo-puppeteer` em processo.

Contexto do monorepo: [`../gym-conversion-tracker-workspace/AGENTS.md`](../gym-conversion-tracker-workspace/AGENTS.md).

## Comandos

| Comando | O que faz |
|---------|-----------|
| `bun run start` | `bun src/server.ts` — **modo padrão**, inclusive no `run-all.ps1` |
| `bun run dev` | Com `--watch`. Evite quando for testar EVO: o restart derruba jobs Puppeteer em andamento |
| `bun run typecheck` | `tsc --noEmit` |

Formas de subir: standalone, via `../gym-conversion-tracker-workspace/run-all.ps1`, ou como `bridge.exe` (compilado com `bun build --compile`) embutido e lançado pelo app Tauri em `../desktop`.

`evo-puppeteer` entra por `"file:../evo-puppeteer"`. Se a pasta for movida ou renomeada, o link quebra e o `bun install` precisa rodar de novo — o `run-all.ps1` verifica isso checando `node_modules/evo-puppeteer/src/index.ts`.

## Onde as coisas moram

| Arquivo | Responsabilidade |
|---------|------------------|
| `src/server.ts` | Rotas, CORS, proxies, `Bun.serve` |
| `src/job.ts` | `Map` de jobs em memória, orquestra o fluxo do `evo-puppeteer` |
| `src/browser.ts` | Ciclo de vida do Chrome por usuário EVO: perfil, launch/reconnect, fila serial, `deleteEvoProfile` |
| `src/chrome.ts` | Descoberta do Chrome no Windows (`EVO_CHROME_PATH` → registry App Paths → caminhos padrão) |
| `src/env.ts` | Leitura de `Bun.env` e defaults de nuvem |
| `src/update.ts` | Auto-update do desktop: `desktopAppInfo`, `fetchLatestBuild`, `applyDesktopUpdate` |

## Superfície HTTP

### `/evo/*` — com CORS

| Método | Rota | Body | Resposta |
|--------|------|------|----------|
| `GET` | `/evo/health` | — | `{ ok: true, service: 'evo-bridge' }` — é assim que o front detecta o bridge |
| `GET` | `/evo/app-info` | — | `{ desktop, version, pid }` |
| `POST` | `/evo/apply-update` | — | `{ ok: true, restarting: true, version }` ou 400 `UPDATE_FAILED` |
| `POST` | `/evo/venda` | `{ attendanceId, ticket? }` | `202 { jobId }` |
| `GET` | `/evo/status/:jobId` | — | `{ job }` ou 404 `NOT_FOUND` |
| `DELETE` | `/evo/perfil` | `{ username }` | `{ ok: true }` — apaga o perfil Chrome daquele usuário EVO |

CORS só cobre `/evo/*`, com `Access-Control-Allow-Private-Network: true` (o Chrome exige para chamadas a loopback vindas de página pública). Origens vêm de `env.allowedOrigins`.

### `/api/*` — proxy para o back

Todos os métodos, encaminhados para `${env.backUrl}${pathname}${search}`, com `redirect: 'manual'`. Cookies de request vão como estão; `sanitizeCookie` reescreve o `Set-Cookie` da resposta em localhost HTTP (tira `Secure`, troca `SameSite=None` por `Lax`) — sem isso a sessão do back nunca gruda no navegador local. `content-encoding`/`content-length`/`transfer-encoding` são removidos porque o `fetch` do Bun já entrega o corpo decodificado e os headers antigos quebram o Chromium.

### `*` — proxy para o front

**Só GET e HEAD** (o resto vira 405). Busca `${env.frontUrl}${pathname}${search}` **pela rede**, removendo `host`, `cookie` e `authorization`. Se o fetch falhar, devolve 503 com a página "Skyfit EVO offline".

> **O bridge não serve `front/build` do disco.** `FRONT_DIST` aparece no `.env.example` e no `README.md` deste app, mas nenhum código o lê — isso é resíduo de uma versão anterior. O `run-all.ps1` ainda exige `front/build/index.html` para subir, embora esse build não seja usado pelo bridge; para testar o front local com o bridge, aponte `FRONT_URL=http://localhost:5173` e rode o Vite.

## Modelo de jobs

`src/job.ts` mantém `const jobs = new Map<string, EvoJobStatus>()` — em processo, sem persistência e **sem TTL nem limpeza**. Em bridge de vida longa o Map cresce indefinidamente.

```typescript
type EvoJobStatus = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  message: string;
  result?: Record<string, string>;  // conferirCadastro()
  error?: string;
  screenshot?: string;              // caminho no disco, só em falha
  createdAt: string;
  updatedAt: string;
};
```

`createEvoJob` dispara `void runJob(...)` e retorna o `jobId` na hora; o front acompanha por polling em `/evo/status/:jobId`. O tipo é espelhado em `front/src/lib/types.ts`.

Concorrência: **não há limite global**, mas `withEvoProfile()` em `browser.ts` encadeia uma fila de Promises por `profileKey` (`sha256(username.toLowerCase()).slice(0, 16)`), então jobs do mesmo usuário EVO rodam em série e usuários diferentes ganham instâncias separadas do Chrome. O Chrome **fica aberto** depois do job — é a revisão manual do cadastro.

Timeout de todas as chamadas Puppeteer: `env.evoTimeoutMs` (90s por padrão).

## Autenticação no back

Em `POST /evo/venda`, se `body.ticket` vier preenchido o bridge manda `Authorization: Bearer <ticket>`; senão repassa o header `Cookie` da requisição. O front sempre manda ticket.

Fluxo completo: o front pede `POST /api/evo/attendances/:id/ticket` (cookie de sessão) → back devolve HMAC de 5 min preso a `attendanceId` + `userId` → front chama `POST /evo/venda` com o ticket → bridge busca o payload com Bearer → back valida e usa o `userId` do ticket para achar as credenciais EVO. O caminho de cookie existe como fallback e não é exercitado em produção, já que o front pode estar em HTTPS remoto (mixed content) sem cookie válido para o hop bridge→back.

## Env

| Variável | Uso |
|----------|-----|
| `BRIDGE_PORT` / `BRIDGE_HOST` | Bind (`4000` / `127.0.0.1`). O loopback é deliberado: mantém o bridge fora da LAN e evita o prompt do Firewall |
| `BACK_URL` | Base da API (default: Cloud Run) |
| `FRONT_URL` | Origem do front para proxy (default: Azure SWA) |
| `FRONT_ALLOWED_ORIGINS` | Origens CORS, separadas por vírgula |
| `EVO_PERFIS_DIR` | Raiz dos `userDataDir` do Chrome (default `.cache/perfis`) |
| `EVO_SCREENSHOTS_DIR` | Screenshots de erro (default `screenshots/`) |
| `EVO_TIMEOUT_MS` | Timeout Puppeteer (default `90000`) |
| `EVO_CHROME_PATH` | Força o executável do Chrome |
| `DESKTOP_APP_VERSION` / `DESKTOP_PID` | Setados pelo desktop; habilitam `/evo/app-info` e `/evo/apply-update` |

`FRONT_DIST` no `.env.example` é morto. O desktop injeta tudo apontando para `%LOCALAPPDATA%\SkyfitEVO\data\`.

## Convenções

Erros próprios seguem `{ error: { code, message } }` com status coerente; erros vindos do back são repassados via `passthrough()` preservando status e `content-type`. Falha de job **não** vira erro HTTP — o `202` já foi devolvido, então o estado fica no registro do job.

Logs vão para stdout/stderr (`console.info` no boot, `console.error` no proxy do front, `log()` do `evo-puppeteer` durante jobs). Sob o desktop isso é capturado em `%LOCALAPPDATA%\SkyfitEVO\data\logs\bridge.{out,err}.log`.

Chrome não encontrado faz `resolveChromePath()` lançar, e o job termina como `failed` com a mensagem.
