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
packages/storage    Web/Worker 共享的薄 R2 对象存储边界
packages/event-store Web/Worker 共享的 Redis GenerationEvent 日志边界
```

## 本地运行

需要 Node.js 24.5+、pnpm 10 和 Docker Desktop。本项目 PostgreSQL 使用宿主机 `5433`，避免占用 monitor-platform 的 `5432`。

```bash
pnpm install
pnpm db:up
pnpm db:migrate
pnpm dev:web
pnpm dev:worker
```

Web 与 Worker 的环境变量分别参考各自的 `.env.example`。真实密钥写入对应的 `.env.local`，这些文件不会进入 Git。

Worker 的 `dev` / `start` 命令在 Node 启动时读取 `.env.local` 并启用原生环境代理：配置 `HTTP_PROXY` / `HTTPS_PROXY` 时走代理，不配置则直连；`NO_PROXY` 用于绕过本机地址。代理连接失败时不自动切换直连重发。修改代理配置后重启 Worker，已有系统环境变量优先于 `.env.local`。

图片 Worker 使用独立的 `IMAGE_BASE_URL`、`IMAGE_MODEL`、`IMAGE_API_KEY`，不复用聊天渠道凭证。未配置时图片任务会明确失败，Chat 不受影响。图片会话支持发送、参考图续改、停止、生成骨架与大图预览；刷新或切换会话后由服务端状态恢复。骨架仅用于展示，不写入 Assistant 消息。

附件读取校验登录身份与归属后签发短期 R2 下载地址，不保存签名 URL。会话详情中的 `activeGeneration` 用于发现正在执行的任务，`latestGeneration` 用于恢复最近一次失败或停止的状态。

## 消息历史与滚动

Chat / Image 共用动态高度虚拟列表，首次只读取最新 30 条消息；向上滚动加载更早的消息，插入历史时保持阅读位置。图片加载与思考展开后重新测量高度，在底部时跟随输出，向上阅读时不自动拉回底部。

正文与思考内容使用 `react-markdown` 渲染 CommonMark 与 GFM，支持表格、任务列表、删除线、KaTeX 数学公式及代码语法高亮。代码块展示语言并支持复制；链接在新窗口打开。原始 HTML 与 Markdown 图片不渲染，图片资产仍通过 Attachment 鉴权链路展示。

- `GET /api/conversations/:id`：最新一页，页内按 `sequence` 升序。
- `GET /api/conversations/:id?before=<nextCursor>`：读取游标之前的一页，`nextCursor: null` 表示没有更早消息。分页使用已有的 `(conversationId, sequence)` 索引，不使用 offset。
- React Query 保存已加载的历史页；发送、停止和 SSE 终态只同步最新消息，保留旧页。离开期间若新增超过一页，会补齐新旧消息之间的缺口。
- UI 分页只影响展示读取，Worker 的 Chat / Image Context Builder 仍按各自规则读取数据库历史，不受浏览器已加载页数限制。

## 验证

```bash
pnpm check
pnpm test:r2
```

`pnpm check` 依次执行 ESLint、TypeScript、单元测试、Docker PostgreSQL/Redis 集成测试和 Next.js production build。图片执行测试使用假模型和内存对象存储，不产生模型调用费用。`pnpm test:r2` 使用本地 R2 配置执行会自动清理测试对象的外部集成测试，不包含在默认检查中。

## 图标来源

浏览器 favicon 使用 Twitter, Inc. 与其他贡献者的 [Twemoji](https://github.com/twitter/twemoji) 聊天气泡图标（U+1F4AC），遵循 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)；仅缩放并转换为 ICO，本地提供，不依赖外部图标服务。
