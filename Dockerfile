FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY src ./src
COPY public ./public
COPY tsconfig.json ./

ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]
