# Gym Conversion Tracker — mapa do monorepo

Sistema para acompanhar atendimentos presenciais, conversão de vendas e performance de recepcionistas, professores e duplas.

Este folder é só orquestração (multi-root VS Code + `run-all.ps1` / `stop-all.ps1`). Os apps ficam nas pastas irmãs montadas no workspace.

## Apps

| App | Propósito | Porta | PM | Entry |
|-----|-----------|-------|----|-------|
| `../back/` | API de domínio (Cloud Run) | `:3000` | bun | `src/index.ts` |
| `../front/` | SPA SvelteKit (Azure SWA) | `:5173` (dev) | bun | `src/routes/` |
| `../evo-bridge/` | Proxy same-origin + jobs EVO | `127.0.0.1:4000` | bun | `src/server.ts` |
| `../evo-puppeteer/` | Automação Puppeteer do EVO | CLI | bun | `src/cli.ts` / `src/index.ts` |
| `../desktop/` | Launcher Tauri Windows (“Skyfit EVO”) | — | Rust/Tauri | `src-tauri/src/main.rs` |
| (este folder) | Orquestração local | — | — | `run-all.ps1`, `stop-all.ps1` |

## Topologia de runtime

- **Stack local completo:** `.\run-all.ps1` → back `:3000` + bridge `:4000` (proxy `/api` → back, todo o resto → `FRONT_URL`). Acesse `http://localhost:4000`. Flags: `-Build`, `-FrontDev`, `-NoInstall`.
- **Front-only dev:** Vite `:5173` → API em `PUBLIC_API_URL` (default `:3000`).
- **Produção:** front Azure SWA; API GCP Cloud Run; desktop pode cair no front/API remotos.
- **Recepção:** bridge/desktop abre Chrome via `evo-puppeteer` para preencher cadastro no EVO (sem salvar).

O bridge **não serve `front/build` do disco** — ele faz proxy HTTP de `FRONT_URL` (default: SWA remoto). Para iterar no front local através do bridge, suba o Vite e rode o bridge com `FRONT_URL=http://localhost:5173`. `FRONT_DIST` no `.env.example` do bridge e a exigência de `front/build/index.html` no `run-all.ps1` são resíduos de uma versão anterior.

## Dependências entre apps

- `evo-bridge` depende de `evo-puppeteer` via `"file:../evo-puppeteer"`.
- `desktop` embute `bridge.exe` (o `evo-bridge` compilado); não embute o front nem sobe o back.
- **Não há pacote TypeScript compartilhado.** Schema canônico: `back/src/db/schema.ts`. Front espelha em `front/src/lib/types.ts`.
- **Não inventar Redis/filas:** jobs EVO são um `Map` in-process em `evo-bridge/src/job.ts`.
- **Não inventar CI:** não há `.github/workflows`. Todo deploy é manual (`back/deploy.ps1`, `front/deploy.ps1`, `desktop/publish.ps1`).

## Fluxo EVO (venda)

1. Credenciais EVO salvas em Conta → `PUT /api/evo/credentials` (senha cifrada com AES-GCM por usuário).
2. Front pede `POST /api/evo/attendances/:id/ticket` — HMAC de 5 min preso a `attendanceId` + `userId`.
3. Front chama bridge `POST /evo/venda` com `{ attendanceId, ticket }`.
4. Bridge busca `GET /api/evo/attendances/:id/payload` (Bearer ticket; cookie é fallback).
5. `evo-puppeteer` preenche o formulário e deixa o Chrome aberto para revisão manual.

O ticket existe porque o front pode estar em HTTPS remoto enquanto o bridge é HTTP em loopback — o hop bridge→back não teria cookie válido.

## Docs por app

- [`../back/AGENTS.md`](../back/AGENTS.md)
- [`../front/AGENTS.md`](../front/AGENTS.md)
- [`../evo-bridge/AGENTS.md`](../evo-bridge/AGENTS.md)
- [`../evo-puppeteer/AGENTS.md`](../evo-puppeteer/AGENTS.md)
- [`../desktop/AGENTS.md`](../desktop/AGENTS.md)

Runbook humano: [`../README.md`](../README.md).
