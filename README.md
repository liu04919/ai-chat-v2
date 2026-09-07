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
packages/mcp        Web/Worker 共享的服务端 MCP Registry、Client 与工具目录
```

## 本地运行

需要 Node.js 24.5+、pnpm 10 和 Docker Desktop。本项目 PostgreSQL 使用宿主机 `5433`，避免占用 monitor-platform 的 `5432`。

```bash
pnpm install
pnpm dev
```

`pnpm dev` 会等待 Docker PostgreSQL/Redis 健康、执行数据库迁移，再并行启动 Web 与 Worker。需要单独调试时仍可使用 `pnpm dev:web` 或 `pnpm dev:worker`。

Web 与 Worker 的环境变量分别参考各自的 `.env.example`。真实密钥写入对应的 `.env.local`，这些文件不会进入 Git。

Worker 的 `dev` / `start` 命令在 Node 启动时读取 `.env.local` 并启用原生环境代理：配置 `HTTP_PROXY` / `HTTPS_PROXY` 时走代理，不配置则直连；`NO_PROXY` 用于绕过本机地址。代理连接失败时不自动切换直连重发。修改代理配置后重启 Worker，已有系统环境变量优先于 `.env.local`。

图片 Worker 使用独立的 `IMAGE_BASE_URL`、`IMAGE_MODEL`、`IMAGE_API_KEY`，不复用聊天渠道凭证。未配置时图片任务会明确失败，Chat 不受影响。图片会话支持发送、参考图续改、停止、生成骨架与大图预览；刷新或切换会话后由服务端状态恢复。骨架仅用于展示，不写入 Assistant 消息。

附件读取校验登录身份与归属后签发短期 R2 下载地址，不保存签名 URL。会话详情中的 `activeGeneration` 用于发现正在执行的任务，`latestGeneration` 用于恢复最近一次失败或停止的状态。

## RAG 数据库底座

PostgreSQL 使用 `docker/postgres/Dockerfile` 构建的 `ai-chat-postgres:18.4-rag` 镜像，仍基于原来的 PostgreSQL 18.4 Alpine，保留 `postgres-data` 卷和 5433 端口。扩展源码固定为具体提交：pgvector 0.8.6、pg_textsearch 1.4.0、zhparser 2.4（依赖 SCWS 1.2.3）。最终镜像不包含构建阶段安装的编译工具。

首次使用或修改 Dockerfile 后：

```bash
docker compose build postgres
docker compose up -d --wait postgres redis
pnpm db:migrate
```

`pg_textsearch` 通过 Compose 的 `shared_preload_libraries` 启动加载；`db:migrate` 在业务迁移前为当前数据库启用三个扩展，并建立 `public.rag_chinese` 中文分词配置。已有数据卷也走这个步骤，不依赖仅在空数据目录执行的 Docker init 脚本；不需要删卷或清库。

两条检索将使用同一套 chunk：`pgvector` 负责语义检索，`pg_textsearch + zhparser` 负责中文 BM25，再通过 RRF 融合和 Rerank 精排。BM25 的 `<@>` 返回负分，升序排列；向量采用余弦距离。数据库过滤条件仍需包含用户和知识库归属，扩展不会替应用完成鉴权。

已接通完整传统 RAG：知识库、文档、chunk 三层结构，独立 BullMQ 入库任务，以及混合检索、精排、聊天注入和引用展示。知识库不依赖会话，原文件使用独立的 R2 对象。

### 在页面中使用

启动 Web 和 Worker 后，侧栏进入「知识库」→「构建你的知识库」→上传文件，等待状态变为「已就绪」。聊天输入框选择一个知识库或「不使用知识库」，可以在同一会话中随时更改下一轮的选择；图片模式不使用知识库。

知识库文件与聊天附件一样由浏览器使用预签名 URL 直传 R2。Web 只接收文件元信息，创建 `uploading` 文档；完成接口核验 R2 对象大小、类型后改为 `pending` 并入队，Worker 再读取原文件解析、向量化。重复完成请求不重复入队；直传中断留下的待上传记录可以删除后重新上传。文档仍使用独立的知识库表，不复用聊天附件记录。

发送时服务端校验知识库归属，将 `knowledgeBaseId` 保存到 Generation。Worker 先执行向量＋BM25 → RRF → Rerank，再将本轮片段作为不可信外部资料加入模型上下文；是否检索不交给模型决定。重新生成沿用原 Generation 的知识库选择，但重新检索当时可用的文档。问题必须包含文本且不超过 2000 字符。

检索结果通过独立的 `knowledge.sources` 展示事件传到前端，保存为回答中的引用快照；仅包括编号、文档名、页码、chunk ID 和原文，不返回向量、内部评分或对象地址。点击回答中的引用编号查看片段，刷新后仍可查看。分享快照包含这些引用片段，不开放整个知识库；删除源文件不删除已经生成的回答和分享引用。历史模型上下文保留回答文字，但不重复注入旧引用原文。

空候选直接返回资料不可用提示，不调用聊天模型；有候选时通过提示词要求证据不足则说明，尚未进行拒答阈值标定或答案支持度验证。检索或精排异常会让本轮明确失败，不静默降级为普通聊天；停止信号会传给 Embedding 和 Rerank 请求。MCP/联网工具仍可并用，原始 Tool 输入/输出仍不发送给前端。

### 本地验证知识库

先配置 `apps/worker/.env.local` 的 `DASHSCOPE_API_KEY`、`EMBEDDING_BASE_URL`、`EMBEDDING_MODEL`，维度固定为 1024。检索还需要 `RERANK_BASE_URL`（百炼业务空间的 `/api/v1` 地址）和 `RERANK_MODEL=qwen3.7-text-rerank`，复用百炼密钥；该模型使用 DashScope 原生重排接口，不是 Embedding 的 OpenAI 兼容地址。执行 `pnpm db:migrate`，并运行 `pnpm dev:worker`。下面的 `ownerId` 使用现有用户 ID；这是受信任的本地开发工具，不是接受客户端 ownerId 的公开接口。

```powershell
pnpm --filter @ai-chat/worker knowledge create <ownerId> "学习资料"
pnpm --filter @ai-chat/worker knowledge upload <ownerId> <baseId> "D:\资料\数据库.md"
pnpm --filter @ai-chat/worker knowledge status <ownerId> <baseId>
pnpm --filter @ai-chat/worker knowledge search <ownerId> <baseId> "数据库如何进行向量检索？"
pnpm --filter @ai-chat/worker knowledge delete <ownerId> <baseId> <documentId>
```

入库流程：读取 R2 → 解析 → 切块 → 分批 Embedding → 事务发布全部 chunk 与 ready 状态。重复 job 不重复入库；失败文档不会参与检索。删除文档先删除数据库记录及 chunk，再删除 R2 原文件；对象删除失败时数据库不会回滚，当前没有补偿任务。进程硬退出可能留下 processing 状态，本轮没有自动恢复；开发阶段可删除后重新上传。

当前基线参数：

- UTF-8 TXT/Markdown、文本型 PDF，文件不超过 10 MB，PDF 不超过 200 页；不做 OCR。
- 使用 `@langchain/textsplitters` 的递归切块器，优先按段落、换行、中文标点拆分，再回退到字符。目标上限 800 个 UTF-16 码元，重叠预算 100（不保证每块正好重叠 100）；不跨 PDF 页，最多 1000 块。薄适配只处理 Unicode 码点回退和原文位置，不重新实现递归算法。保留页码和提取文本内的位置；不是 token 切块，也没有标题/表格结构解析。
- Embedding 每批 10 条，每批 60 秒超时，不自动重试。使用百炼 OpenAI 兼容接口，未启用 DashScope 原生接口的 query/document 区分。
- 按账户、知识库、ready 状态和 Embedding 模型过滤，语义与 BM25 各取 30 条，RRF（常数 60）合并去重后保留全部候选（最多 60 条），精排选前 6 条。结果中的 `score` 保留 RRF 分数，`rerankScore` 是精排分数，两者不混加，也不能当作回答正确的概率。以上是当前基线参数，尚未针对上传文件调参。
- 精排单次请求超时 60 秒，不自动重试，不静默回退 RRF。响应校验数量、索引唯一性与范围、分数有效性；通过索引回填原 chunk 的来源，不信任上游返回的正文或 ID。空候选不发送请求。更换精排模型不需要重新 Embedding 文档。
- 查询先取得允许访问的文档 ID，把该过滤放进 chunk 的 Top K 查询。向量直接按余弦距离排序，BM25 直接按索引打分排序；只物化已取出的候选，不预先物化全部 chunk。向量查询在事务内设置 `SET LOCAL hnsw.iterative_scan = strict_order`，补充过滤后的候选；受扫描上限约束，并非保证召回齐全。正式查询不强制索引，执行计划由 PostgreSQL 选择。
- BM25 继续使用共享索引的语料统计，不是每个知识库独立计算 IDF。分块变更只影响新上传的文档；已有文档若要采用新策略，需要重新上传，不自动改写已有向量。

测试覆盖数据库/队列、账户隔离、失败与重复任务、原子发布、删除、解析和分批请求。`knowledge-search.integration.test.ts` 使用同一条业务 SQL 执行 `EXPLAIN (ANALYZE, BUFFERS)`，在仅测试启用的计划设置下验证两个索引可用，以及过滤掉 90% 数据后返回 30 条。测试使用可控向量验证流程，不能当成检索效果或性能跑分；效果评测需要另外准备标注问题与相关 chunk。

```bash
pnpm exec vitest run packages/db/src/rag-extensions.integration.test.ts
```

实现参考：[pg_textsearch](https://github.com/timescale/pg_textsearch/tree/v1.4.0)、[pgvector](https://github.com/pgvector/pgvector/tree/v0.8.6)、[zhparser](https://github.com/amutu/zhparser/tree/2e995c4df672563992b4d7a147b8fa2d0d4cda6c)。

### 独立检索评测

评测入口位于 [evals/retrieval](evals/retrieval/README.md)，不再放在 Worker 的业务 CLI 中。使用独立 PostgreSQL 数据库、相同业务 schema/检索 SQL/Embedding/RRF/精排实现，公开数据不会混入用户知识库或影响业务 BM25 统计。

四组对照为纯向量、纯 BM25、混合 RRF、混合 RRF＋精排，指标统一交给 Python `ranx` 计算。数据下载、固定抽题、预算记录、断点续跑和报告命令见评测目录；旧 `knowledge compare/evaluate` 已移除。这是检索层消融实验，不是最终回答或 Agentic RAG 评测。

## Tool 与联网搜索

Chat 输入框的联网搜索开关只影响本次 Generation，Worker 使用 Tavily 将 `web_search` 作为本地 Tool 注入模型；它不属于 MCP 工具目录，也不会永久绑定 Conversation。Sidebar 的 MCP 入口打开独立工具页，按“个人工具 / 公开工具”和 Server 展示能力，允许逐 Tool 启用，Server 级按钮只是全选/清空快捷操作。启用配置属于当前用户；发送时以稳定的 `serverId.toolName` 快照到 Generation，执行时再通过远程 MCP Client 的 `tools()` 获取真实可执行工具。

模型的多步 `tool-call → tool-result → 继续生成` 由 Worker 和 AI SDK 完成。完整 Tool 输入与结果只在 Worker 内部流转并持久化为服务端 Assistant Message Parts，供后续 Context Builder 重建无状态 Provider 上下文；Redis GenerationEvent、SSE 与会话详情只向浏览器投影 Tool 名称、调用完成或失败等展示状态，不传原始 `input/output`。重新生成沿用原 Generation 的 Tool 选择，不依赖第三方保存会话状态。

启用联网搜索前，在 `apps/worker/.env.local` 配置 `TAVILY_API_KEY`。MCP URL、Bearer Token 与第三方 AK 同时配置在 Web 和 Worker 的服务端本地环境中：Web 只用于发现目录，Worker 才执行 Tool；这些连接信息不会进入目录响应、浏览器或消息正文。单个 Server 发现失败只会在工具页标记该 Server 暂不可用。

## 消息历史与滚动

Chat / Image 共用动态高度虚拟列表，首次只读取最新 30 条消息；向上滚动加载更早的消息，插入历史时保持阅读位置。图片加载与思考展开后重新测量高度，在底部时跟随输出，向上阅读时不自动拉回底部。

正文与思考内容使用 `react-markdown` 渲染 CommonMark 与 GFM，支持表格、任务列表、删除线、KaTeX 数学公式及代码语法高亮。代码块展示语言并支持复制；链接在新窗口打开。原始 HTML 与 Markdown 图片不渲染，图片资产仍通过 Attachment 鉴权链路展示。

- `GET /api/conversations/:id`：最新一页，页内按 `sequence` 升序。
- `GET /api/conversations/:id?before=<nextCursor>`：读取游标之前的一页，`nextCursor: null` 表示没有更早消息。分页使用已有的 `(conversationId, sequence)` 索引，不使用 offset。
- React Query 保存已加载的历史页；发送、停止和 SSE 终态只同步最新消息，保留旧页。离开期间若新增超过一页，会补齐新旧消息之间的缺口。
- UI 分页只影响展示读取，Worker 的 Chat / Image Context Builder 仍按各自规则读取数据库历史，不受浏览器已加载页数限制。

## 会话管理

Sidebar 支持按用户置顶和删除会话。置顶会话独立成组，并按最近置顶时间排列；置顶操作不会改变会话的消息活跃时间。删除会话会级联清理 PostgreSQL 中的消息与 Generation，通知仍在运行的 Worker 停止，并清理消息引用的 R2 附件对象。

会话菜单支持创建和停止公开分享。创建时把当前已持久化的可见消息、附件元数据与标题写入独立的 `conversation_shares` 不可变快照；已有分享再次创建会返回原链接，不会随之后的聊天或重命名变化。存在 Active Generation 时拒绝创建。`/share/:token` 由 Server Component 直接查询并渲染，不依赖 Redis、BullMQ、SSE 或登录态；分享附件仍保存在私有 R2，由公开附件路由在校验 token 与快照引用后代理读取。停止分享会删除快照，使页面和附件入口失效。

- `GET /api/conversations/:id/share`：读取当前用户的分享状态。
- `POST /api/conversations/:id/share`：创建一次不可变分享快照。
- `DELETE /api/conversations/:id/share`：停止分享。
- `GET /share/:token`：服务端渲染的公开只读页面。

## 验证

```bash
pnpm check
pnpm test:r2
```

`pnpm check` 依次执行 ESLint、TypeScript、单元测试、Docker PostgreSQL/Redis 集成测试和 Next.js production build。图片执行测试使用假模型和内存对象存储，不产生模型调用费用。`pnpm test:r2` 使用本地 R2 配置执行会自动清理测试对象的外部集成测试，不包含在默认检查中。

## 图标来源

浏览器 favicon 使用 Twitter, Inc. 与其他贡献者的 [Twemoji](https://github.com/twitter/twemoji) 聊天气泡图标（U+1F4AC），遵循 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)；仅缩放并转换为 ICO，本地提供，不依赖外部图标服务。
