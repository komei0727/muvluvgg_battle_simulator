# syntax=docker/dockerfile:1
#
# `11_インフラストラクチャ設計.md`「Container契約」multi-stage build:
# production依存、`dist/`、Catalogだけをruntime imageへ含める。
# Linux amd64向けに再現可能な固定digestのbase imageを使用する
# （node:24.18.0-bookworm-slim、mise.tomlのNode.jsバージョンと一致）。

ARG NODE_IMAGE=node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ARG PNPM_VERSION=11.8.0

FROM --platform=linux/amd64 ${NODE_IMAGE} AS base
ARG PNPM_VERSION
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM deps AS build
COPY tsconfig.json tsconfig.node.json ./
COPY src ./src
RUN pnpm run build

# `runtime`: non-root userで実行し、production依存・コンパイル済みdist・Catalogだけを含める。
FROM base AS runtime
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 nodeapp \
  && useradd --system --uid 1001 --gid nodeapp --home-dir /app --shell /usr/sbin/nologin nodeapp

COPY --from=prod-deps --chown=nodeapp:nodeapp /app/node_modules ./node_modules
COPY --from=build --chown=nodeapp:nodeapp /app/dist ./dist
COPY --chown=nodeapp:nodeapp package.json ./
COPY --chown=nodeapp:nodeapp catalog ./catalog

USER nodeapp

# Cloud Runが注入する$PORTへ`HOST=0.0.0.0`（`src/bootstrap/config.ts`の既定値）でlistenする。
EXPOSE 8080

CMD ["node", "--enable-source-maps", "dist/main.js"]
