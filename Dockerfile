FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN npm install --global pnpm@10.24.0

# 先安装依赖，源码变化时可复用这一层；本地 .env 不进入构建上下文。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/event-store/package.json ./packages/event-store/package.json
COPY packages/mcp/package.json ./packages/mcp/package.json
COPY packages/model-context/package.json ./packages/model-context/package.json
COPY packages/storage/package.json ./packages/storage/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS source
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

FROM source AS web-build
ENV NEXT_TELEMETRY_DISABLED=1
# 构建只需要初始化配置，不连接真实数据库，也不读取线上密钥。
RUN DATABASE_URL=postgres://build:build@127.0.0.1:5432/build \
    BETTER_AUTH_SECRET=build-only-placeholder-not-a-runtime-secret \
    BETTER_AUTH_URL=http://localhost:3001 \
    pnpm --filter @ai-chat/web build

FROM node:24-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=web-build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# Worker 沿用项目现有的 tsx 运行方式；同一镜像也用于执行数据库迁移。
FROM source AS worker
ENV NODE_ENV=production
USER node
CMD ["node", "--import", "tsx", "--use-env-proxy", "apps/worker/src/index.ts"]
