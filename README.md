# Gym Conversion Tracker

Sistema para acompanhar atendimentos presenciais, conversão de vendas, performance de recepcionistas, professores e duplas recepcionista-professor.

## Estrutura

- `back/`: API Bun + Hono + PostgreSQL + Drizzle + SMTP AWS.
- `front/`: SvelteKit estático com Svelte 5, Tailwind e Playwright.
- `evo-puppeteer/`: automação Puppeteer do EVO.
- `evo-bridge/`: servidor local que entrega o build do front e aciona o Puppeteer.

## Subir tudo de uma vez

Com o PostgreSQL no ar e `back/.env` configurado, rode na raiz do workspace:

```powershell
.\gym-conversion-tracker-workspace\run-all.ps1
```

O script instala dependências que faltarem e sobe o backend (`:3000`) e o
evo-bridge (`:4000`), que serve o build já existente em `front/build`, com os
logs multiplexados no terminal. Acesse `http://localhost:4000`. Ctrl+C encerra
todas as partes (inclusive o Chrome do Puppeteer). O build do front é gerado à
parte (`PUBLIC_API_URL=/ bun run build` na pasta `front`); `-Build` força o
rebuild antes de subir, `-FrontDev` também sobe o Vite dev em `:5173`,
`-NoInstall` pula a verificação de dependências. Se o terminal morrer de forma
abrupta e sobrarem processos, `.\gym-conversion-tracker-workspace\stop-all.ps1`
limpa tudo pelo arquivo `.run-all.pids` e pelas portas do app.

## Backend

1. Configure `back/.env` a partir de `back/.env.example`.
2. Instale dependências:

```bash
cd back
bun install
```

3. Rode migrations e seeds:

```bash
bun run db:migrate
bun run db:seed
```

4. Crie o primeiro ADMIN técnico:

```bash
bun run bootstrap:admin "Nome Admin" admin@exemplo.com "senha-segura"
```

5. Inicie a API:

```bash
bun run dev
```

O banco usa o schema PostgreSQL `"gym-conversion-tracker"`. O atendimento sempre recebe `started_at` no servidor e não aceita criação retroativa. Eventos subsequentes são append-only.

## Frontend

Configure `PUBLIC_API_URL` se a API não estiver em `http://localhost:3000`.

```bash
cd front
bun install
bun run dev
```

O build é SPA estático com fallback `index.html`.

## Integração EVO

1. No backend, configure `EVO_CRED_KEY` com uma chave base64 de 32 bytes para criptografar senhas do EVO.
2. Rode as migrations para adicionar dados de EVO aos leads, usuários e academias.
3. Gere o build do front para mesma origem do bridge:

```bash
cd front
PUBLIC_API_URL=/ bun run build
```

4. Inicie o bridge local:

```bash
cd ../evo-bridge
bun install
bun run start
```

A recepcionista acessa `http://localhost:4000`. A página `Conta` permite salvar as
credenciais do EVO e esquecer a sessão persistida do navegador. Ao registrar uma
venda, o front pode preencher um novo cadastro no EVO e deixa o Chrome aberto para
revisão e salvamento manual.

## Aplicativo desktop Windows

O empacotamento Tauri gera um `.exe` único com o front estático e o `evo-bridge`
embutidos. A máquina da recepção ainda precisa ter o Google Chrome instalado,
pois a automação EVO usa o Chrome local e o mantém aberto após fechar o app para
permitir revisão e salvamento manual.

```powershell
cd desktop
.\build.ps1
```

O script instala dependências dos pacotes EVO, gera o build do front com
`PUBLIC_API_URL=/`, compila `desktop/src-tauri/payload/bridge.exe` e roda
`cargo tauri build`. Use `-SkipChecks` para pular os typechecks EVO, ou
`-BackUrl https://...` para trocar o backend remoto embutido. Na inicialização, o
desktop tenta usar `http://localhost:4000` primeiro; se não houver app local, ele
inicia o bridge embutido; se o local falhar, abre o backend/app remoto da Cloud
Run.

Os artefatos finais ficam em `desktop/dist/`:

- `Skyfit-EVO-<version>.exe`
- `Skyfit-EVO-<version>.zip`, contendo o executável e `LEIA-ME.txt`

## Métricas

- Receita global soma cada venda uma única vez.
- Atribuição original: venda conta para o recepcionista, professor e dupla do atendimento em que o lead foi recebido.
- Atribuição de fechador: venda também é exibida para o usuário que registrou o fechamento.
- Denominador da recepção: todo atendimento iniciado, inclusive “Já era aluno”.
- Denominador de professor e dupla: somente atendimentos em que houve apresentação por professor.
- Valores de planos são versionados por snapshot em `sales`; editar o valor atual de um plano não altera vendas antigas.

## Verificações

```bash
cd back
bun run check
bun test

cd ../front
bun run check
bun run test:unit -- --run
bun run build

cd ../evo-bridge
bun run typecheck
```

