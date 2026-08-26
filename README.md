# AI Chat V2

AI Chat V2 是对本地 `D:\code\Next\ai-chat` 的正式重构。项目保留流式聊天、断线恢复、Tool/MCP、RAG、文件处理、分享与 Image Pipeline 等能力，并重新建立清晰、可测试、可解释的领域、协议和运行时边界。

架构决定见 [AI_CHAT_V2_ARCHITECTURE_BRIEF.md](./AI_CHAT_V2_ARCHITECTURE_BRIEF.md)。

## Workspace

```text
apps/web            Next.js Web/API
apps/worker         独立 Node Worker runtime
packages/contracts  跨 runtime 的运行时 Schema 与 wire types
packages/core       不依赖框架的领域规则
packages/db         Drizzle schema、PostgreSQL client 与 migrations
```

## 本地运行

需要 Node.js 24+、pnpm 10 和 Docker Desktop。本项目 PostgreSQL 使用宿主机 `5433`，避免占用 monitor-platform 的 `5432`。

```bash
pnpm install
pnpm db:up
pnpm db:migrate
pnpm dev:web
pnpm dev:worker
```

Worker 的模型环境变量参考 `apps/worker/.env.example`。真实密钥写入 `apps/worker/.env.local`，该文件不会进入 Git。

## 验证

```bash
pnpm check
```

该命令依次执行 ESLint、TypeScript、领域/契约测试、真实 PostgreSQL 集成测试和 Next.js production build。
