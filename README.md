# Gym Conversion Tracker

Sistema para acompanhar atendimentos presenciais, conversão de vendas, performance de recepcionistas, professores e duplas recepcionista-professor.

## Estrutura

- `back/`: API Bun + Hono + PostgreSQL + Drizzle + SMTP AWS.
- `front/`: SvelteKit estático com Svelte 5, Tailwind e Playwright.

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
```

