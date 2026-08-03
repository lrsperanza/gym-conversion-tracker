# desktop — launcher Tauri "Skyfit EVO"

App Windows que existe por um motivo só: dar à recepção uma origem `http://localhost` para o front, para que ele possa falar com o bridge local (e portanto com o Chrome do EVO) sem esbarrar em mixed content. Ele embute e sobe o `bridge.exe`, espera ficar pronto e abre uma webview apontando para `http://localhost:4000`.

Contexto do monorepo: [`../gym-conversion-tracker-workspace/AGENTS.md`](../gym-conversion-tracker-workspace/AGENTS.md).

## Stack

Tauri **v2** (`tauri 2.11.5`), Rust edition 2021, pacote `skyfit-evo-desktop`. Produto `Skyfit EVO`, identificador `com.skyfit.evo`.

Toda a lógica está em `src-tauri/src/main.rs` (~700 linhas) mais `src-tauri/build.rs`. Crates relevantes: `tauri-plugin-single-instance`, `ureq` (update), `sha2`/`hex` (integridade), `tar`/`zstd` (payload), `serde`.

Pontos do `tauri.conf.json` que costumam surpreender:

- `bundle.active: false` — **não gera NSIS/MSI**, a entrega é um `.exe` solto.
- `webviewInstallMode: "skip"` — assume WebView2 já instalado.
- `withGlobalTauri: false` e **nenhum `#[tauri::command]` registrado**. A webview não tem API Tauri; o splash é atualizado por `window.eval("window.setStartupStatus(...)")`.
- `frontendDist: "../splash"` — o único frontend empacotado é `splash/index.html`. A janela principal é criada em runtime no Rust com `WebviewUrl::External`.
- Sem `plugins.updater` e sem `tauri-plugin-updater`: o auto-update é próprio (ver abaixo).
- Sem pasta `capabilities/`; o schema de permissões gerado está vazio.

## Boot (`start_desktop` em `main.rs`)

1. `install_app()` em thread: copia o exe para `%LOCALAPPDATA%\SkyfitEVO\app\Skyfit-EVO-{version}.exe`, cria o atalho `Skyfit EVO.lnk` na área de trabalho e apaga versões antigas.
2. `maybe_apply_update()`: `GET {back}/api/desktop/latest`; se houver versão maior, baixa, refaz o atalho, agenda relaunch por `cmd` destacado e `app.exit(0)`.
3. Sonda um bridge que já esteja de pé (TCP + `GET /evo/health` em `127.0.0.1:4000`). Se responder, pula direto para a janela principal.
4. `extract_payload()`: descomprime o `payload.tar.zst` embutido via `include_bytes!` para `%LOCALAPPDATA%\SkyfitEVO\runtime\{APP_VERSION}\`, guardando o marcador `.complete` com `SKYFIT_PAYLOAD_FINGERPRINT`. Timeout de 180s a frio, 45s a quente.
5. `spawn_bridge()`: roda `bridge.exe` sem janela de console, com `BRIDGE_PORT`, `BACK_URL`, `FRONT_URL`, `DESKTOP_APP_VERSION`, `DESKTOP_PID`, `EVO_PERFIS_DIR`, `EVO_SCREENSHOTS_DIR`. Logs em `%LOCALAPPDATA%\SkyfitEVO\data\logs\bridge.{out,err}.log`.
6. `wait_for_local_bridge()`: se subir, janela principal em `http://localhost:4000`. Se não, mostra erro no splash por 5s e cai para `configured_front_url()` (o SWA remoto) — **nesse modo o EVO não funciona**, porque não há bridge local. `watch_for_late_bridge()` ainda pode redirecionar a janela de volta para localhost por até 300s.

O `back` **não** é iniciado pelo desktop; ele sempre usa a API remota. Ao sair, `kill_bridge()` derruba o filho. Segunda instância apenas foca a janela existente.

URLs default compiladas quando `SKYFIT_*` não é passado no build:

- back: `https://gym-conversion-tracker-437354431924.southamerica-east1.run.app`
- front: `https://nice-pebble-04842d70f.7.azurestaticapps.net`

## Payload embutido

`build.rs` empacota `src-tauri/payload/` em `payload.tar.zst` e exporta o fingerprint FNV-1a. O `build.ps1` coloca lá **apenas `bridge.exe`**, compilado de `evo-bridge/src/server.ts` com `bun build --compile --target=bun-windows-x64-baseline`.

> O `README.md` da raiz diz que o desktop embute o "front estático". Não embute — o bridge faz proxy do front remoto em runtime. Se a internet cair, o usuário vê a página "Skyfit EVO offline" servida pelo bridge.

## Build e publish

```powershell
cd desktop
.\build.ps1      # -SkipChecks, -BackUrl, -FrontUrl
.\publish.ps1    # -Bump patch|minor|major, -SetVersion, -Build, -NoBuild, -NoPrompt, -ExePath, -SkipChecks
```

`build.ps1` valida `bun`/`cargo`/`cargo tauri` v2, instala deps de `evo-puppeteer` e `evo-bridge`, roda typecheck, compila o `bridge.exe` no payload, gera ícones, faz `cargo tauri build` com `SKYFIT_BACK_URL`/`SKYFIT_FRONT_URL` no ambiente e copia o resultado para `desktop/dist/Skyfit-EVO-{version}.exe` (+ zip + `LEIA-ME.txt`).

`publish.ps1` lê a versão de `tauri.conf.json` **e** `Cargo.toml` (precisam bater), oferece bump, sincroniza os dois arquivos, pergunta se deve buildar (a menos que venha `-Build`/`-NoBuild`/`-NoPrompt`) e então roda `bun src/scripts/publish-desktop.ts <exe>` **de dentro de `back/`** — ou seja, quem publica usa `back/.env` (`AZURE_STORAGE_ACCOUNT_NAME`, `AZURE_STORAGE_ACCOUNT_KEY`, `DESKTOP_BLOB_CONTAINER`, `DESKTOP_BUILD_PREFIX`), **não** o `desktop/.env`. O nome do arquivo precisa casar `{DESKTOP_BUILD_PREFIX}{semver}.exe`, senão o script recusa.

Não há CI: build e publish são manuais.

## Auto-update

Dois caminhos, mesma origem de verdade:

| Caminho | Quando | Onde |
|---------|--------|------|
| Startup (Rust) | Todo lançamento, antes do bridge | `maybe_apply_update()` em `main.rs` |
| Em uso (bridge) | Pelo front | `POST /evo/apply-update` → `evo-bridge/src/update.ts` |

Ambos consultam `GET {back}/api/desktop/latest`, que lista os blobs do Azure pelo prefixo, ordena por semver e devolve `{ version, fileName, size, publishedAt, sha256, downloadUrl }` com SAS de leitura de 30 min. Baixam para `%LOCALAPPDATA%\SkyfitEVO\app\`, conferem o SHA256, refazem o atalho e relançam com `taskkill` + `start`.

**Não há assinatura de código nem chave de updater** — nem Authenticode, nem minisign/ed25519. A integridade é só o SHA256 gravado nos metadados do blob. É o ponto fraco conhecido da distribuição.

## Env

`desktop/.env` tem `AZURE_STORAGE_ACCOUNT_NAME` e `AZURE_STORAGE_ACCOUNT_KEY`, mas **nenhum script o lê** (o publish roda a partir de `back/`).

Compilados no binário via `option_env!`: `SKYFIT_BACK_URL`, `SKYFIT_FRONT_URL`, `SKYFIT_PAYLOAD_FINGERPRINT`. Runtime: `SKYFIT_DEVTOOLS=1` abre o devtools da janela principal.

## Rodando localmente

Não existe script de dev aqui. Opções: rodar o exe de `desktop/dist/`, ou `cargo tauri dev` em `src-tauri` (exige Tauri CLI v2). Para mexer no produto sem tocar no Tauri, prefira `../gym-conversion-tracker-workspace/run-all.ps1` e abrir `http://localhost:4000` no navegador — é a mesma topologia que o desktop cria.

Pré-requisitos: Rust, `cargo tauri` v2, Bun, Google Chrome (para o EVO), WebView2.

Layout na máquina do usuário:

```
%LOCALAPPDATA%\SkyfitEVO\
  app\Skyfit-EVO-{version}.exe
  runtime\{version}\bridge.exe
  data\{perfis,screenshots,logs}
```

Bump de versão só via `publish.ps1` (mantém `tauri.conf.json` e `Cargo.toml` em sincronia). Editar um dos dois à mão quebra o publish.
