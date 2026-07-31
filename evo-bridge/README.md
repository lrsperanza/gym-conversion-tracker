# evo-bridge

Servidor local Bun + Hono que entrega o build estático do front, faz proxy para o
backend e abre o Chrome com Puppeteer para preencher cadastros no EVO.

## Instalação

```bash
bun install
```

Copie `.env.example` para `.env` se precisar alterar portas ou caminhos:

```bash
BRIDGE_PORT=4000
BACK_URL=http://localhost:3000
FRONT_DIST=../front/build
EVO_PERFIS_DIR=.cache/perfis
EVO_TIMEOUT_MS=90000
```

## Uso

1. Inicie o backend em `http://localhost:3000`.
2. Gere o build do front para usar a mesma origem do bridge:

```bash
cd ../front
PUBLIC_API_URL=/ bun run build
```

3. Inicie o bridge:

```bash
cd ../evo-bridge
bun run start
```

4. Abra `http://localhost:4000`.

## Fluxo

- `/api/*` é encaminhado para o backend, preservando cookies de sessão.
- `/evo/venda` busca no backend as credenciais do usuário logado e os dados do
  atendimento, então inicia um job Puppeteer local.
- O navegador usa `userDataDir` por usuário EVO, então sessões válidas são
  reaproveitadas e a tela de login é pulada quando possível.
- O job preenche o formulário de novo cadastro e deixa o navegador aberto para a
  recepcionista revisar e salvar manualmente. O bridge não salva o cadastro no EVO.

Use a página `Conta` para cadastrar/trocar credenciais do EVO ou esquecer a sessão
salva do navegador.
