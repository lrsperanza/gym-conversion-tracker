FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN apk add --no-cache ffmpeg
RUN bun install --frozen-lockfile --production

COPY . .

ENV NODE_ENV=production
EXPOSE 8080

CMD ["bun", "src/index.ts"]
