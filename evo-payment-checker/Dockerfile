# Build a partir da RAIZ do monorepo (precisa do evo-puppeteer ao lado):
#   docker build -f evo-payment-checker/Dockerfile .
# O Dockerfile.dockerignore ao lado deste arquivo limita o contexto ao necessário.
FROM oven/bun:1-debian

RUN apt-get update \
	&& apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates tzdata \
	&& rm -rf /var/lib/apt/lists/*

ENV TZ=America/Sao_Paulo \
	NODE_ENV=production \
	EVO_CHROME_PATH=/usr/bin/chromium \
	EVO_HEADLESS=true \
	EVO_SCREENSHOTS_DIR=/tmp/screenshots

WORKDIR /app

# evo-puppeteer entra como "file:../evo-puppeteer"; precisa estar completo antes do install.
COPY evo-puppeteer/ ./evo-puppeteer/
RUN cd evo-puppeteer && bun install --production

# bun.loc[k]: o lockfile é opcional (o glob não falha se ainda não existir).
COPY evo-payment-checker/package.json evo-payment-checker/bun.loc[k] ./evo-payment-checker/
RUN cd evo-payment-checker && bun install --production

COPY evo-payment-checker/src ./evo-payment-checker/src

WORKDIR /app/evo-payment-checker
CMD ["bun", "src/check.ts"]
