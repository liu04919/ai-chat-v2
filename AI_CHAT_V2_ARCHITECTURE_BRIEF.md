# AI Chat V2 架构约束

本文档只记录会长期约束实现的架构决策。开发顺序、文件拆分、依赖选型和局部实现不在这里预排，它们随代码现状逐轮讨论。

- V2 仓库：`https://github.com/liu04919/ai-chat-v2`
- V1 参考项目：`D:\code\Next\ai-chat`
- 项目定位：功能完整、架构清晰、可测试、可解释的求职项目，不是玩具 Demo，也不追求基础设施高可用

## 1. 文档效力

决策优先级：

```text
开发者最新明确拍板的决定
> 本文档
> 当前代码与运行行为
> V1 历史实现
```

代码只能说明“现在是什么”，不能自动决定“应该是什么”。代码与本文档冲突时，先按实现偏差处理；只有开发者确认设计变更后，才能同步修改代码与本文档。

本文档动态维护，但不记录聊天流水账：

- 新决定推翻旧决定时，直接改写旧结论
- Codex 可以更新实现状态和验证事实
- 架构边界与硬约束必须由开发者确认后修改
- 施工顺序、临时方案和详细交接信息放项目记忆或当轮讨论

## 2. 总体目标与边界

V2 保留 V1 有价值的产品能力，同时重建边界：流式聊天、历史分页、断线恢复、Tool/MCP、联网搜索、RAG、文件、分享与独立图片生成。

V2 不允许退化成普通的 Next.js Route 转发模型请求。以下复杂度有真实职责，必须保留：

- Web/API 与长期运行 Worker 分离
- 自有领域模型和 Generation 事件协议
- PostgreSQL、BullMQ、Redis Streams 各司其职
- 原生 Server-Sent Events（SSE）重放与恢复
- 服务端流式合并与前端渲染调度
- AI SDK、模型网关和向量数据库的 Adapter 边界
- 数据库约束、鉴权、输入校验、迁移、关键测试与必要日志

当前不解决 PostgreSQL、Redis、BullMQ 或 Worker 宕机后的自动修复。不得为假设中的故障提前引入 Outbox、分布式事务、补偿任务、复杂重试、Kafka、Temporal、Kubernetes、CQRS 或通用事件总线。

### 已确认技术栈

| 领域 | 技术与用途 |
| --- | --- |
| Web | Next.js、React、TypeScript |
| UI | shadcn/ui、Tailwind CSS |
| 表单 | React Hook Form；与运行时 Schema resolver 集成 |
| 服务端状态 | TanStack Query，负责查询、缓存、失效与刷新 |
| 长列表 | TanStack Virtual，负责消息列表虚拟化 |
| 客户端状态 | Zustand，只保存适合浏览器的临时交互状态和 Generation Projection |
| 数据库 | PostgreSQL、Drizzle ORM 与 migration |
| Markdown | React Markdown；remark/rehype 插件按真实渲染需求增加 |
| 后台与事件 | BullMQ、Redis、Redis Streams、独立 Node Worker |
| 本地基础设施与架构验证 | Docker、Docker Compose |
| LLM | AI SDK Core，经自有 Adapter 接入模型服务 |

技术用途已经拍板，具体版本在初始化或真正使用时根据兼容性确认，不照抄 V1 的版本。`D:\code\Next\ai-chat` 可用于理解前端交互和既有用法；其后端、Docker、数据库、队列、鉴权与部署方案不是 V2 的架构依据。

## 3. 系统拓扑

```text
Browser
  │ HTTP command / query
  │ SSE subscription
  ▼
Next.js Web/API
  ├─ PostgreSQL：永久业务状态
  ├─ BullMQ：后台任务
  └─ Redis Streams：短期 Generation 事件日志
                    ▲
                    │ GenerationEvent
Node Worker ────────┘
  ├─ Context Builder
  ├─ LLM Runtime / AI SDK Adapter
  ├─ Tool Registry / MCP
  └─ Retrieval
```

Web 与 Worker 位于同一 workspace，但拥有独立运行生命周期。是否继续拆 package 取决于真实依赖，不按模板机械分层。

## 4. 领域与数据所有权

### Conversation

Conversation 创建时选择 `chat` 或 `image`，之后不可修改。产品层不提供聊天模型动态切换；Provider、Base URL 和模型路由属于服务端基础设施配置。

同一个 Conversation 同时最多存在一个 `queued` 或 `running` Generation。该约束必须由服务器和数据库保证，不能只依赖前端按钮禁用。

### Message

Message 是永久业务记录，不使用 AI SDK 的 `UIMessage` 作为领域类型。

```ts
type MessagePart =
  | { type: "text"; text: string }
  | { type: "attachment"; attachmentId: string };
```

当前 Message 只支持 `text | attachment`。Source 和 Image 在对应产品能力落地时再扩展。Tool execution 默认属于 Generation 执行记录，不是 MessagePart。

### Generation

Generation 表示一次根据用户输入生成回答的执行：

```ts
type GenerationStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
```

Generation 与最终 Assistant Message 不是同一个对象。执行中的 reasoning、tool call 和文本增量属于 Generation；完成后的回答才成为 Message。

### 存储职责

- **PostgreSQL**：Conversation、Completed Message、Generation 状态、Attachment、Knowledge、Share Snapshot
- **BullMQ**：把 Generation 和知识入库任务交给 Worker，不作为业务事件历史
- **Redis Streams**：短期 Generation Event Log，支持实时消费和断线重放，不作为永久数据库

PostgreSQL 是 Completed Message 的唯一永久事实来源。前端刷新后不能从 Redis 或浏览器缓存重建永久消息。

## 5. 自有跨边界协议

Browser、Web/API 与 Worker 之间的可序列化契约集中在 `packages/contracts`。契约使用运行时 Schema，并从 Schema 推导 TypeScript 类型；请求入口、Worker job、Redis 事件读取和浏览器事件入口都要验证。

`packages/contracts` 只描述系统边界上传输什么：

- HTTP request、response 与统一错误
- Completed Message DTO
- Worker job payload
- GenerationEvent
- cursor 和分页值
- 可执行 fixtures 与 contract tests

它不包含：

- 领域实体或数据库 row
- AI SDK stream part
- BullMQ、Redis 或 SSE 的基础设施容器
- React state 与组件 props
- 普通工具类型

领域实体与 wire DTO 在应用边界映射。消费者不得各自复制相似 DTO。

### GenerationEvent

当前协议只实现真实消费者需要的事件。文字生成主链包含：

```text
generation.started
text.delta
reasoning.delta  # 上游实际提供时才有
generation.completed
generation.failed
generation.cancelled
```

Tool 和来源能力接入时再增加 `tool.called`、`tool.completed`、`source.added`。不得提前实现没有调用方的未来事件。

Redis Stream 和 SSE 传输同一个 GenerationEvent，不再定义第二套 SSE 业务协议。Redis Stream ID 默认直接作为 SSE `id` 和恢复 cursor；只有出现明确需求并经开发者确认后才能增加映射层。

## 6. Generation 主链与恢复语义

### 创建命令

```text
POST Generation
→ 校验 auth、ownership 与 Conversation 状态
→ 持久化 User Message 和 queued Generation
→ enqueue BullMQ
→ 返回 initial Generation
```

POST 不运行模型，不把生成生命周期绑在 HTTP 请求上。

客户端为新消息生成稳定的 `userMessageId`，服务器执行最小幂等：

- 相同 ID、相同 Message parts：返回第一次创建的 Generation，不重复写入或 enqueue
- 相同 ID、不同 Message parts：返回冲突
- 不同 ID、Conversation 已有 Active Generation：返回 `409 ACTIVE_GENERATION` 和 `activeGenerationId`

`generationId` 必须贯穿 PostgreSQL、BullMQ job、Worker、Redis event、Assistant Message 关联和日志。BullMQ 使用它作为 `jobId`；Worker 开始前确认 Generation 仍为 `queued`，并保证一个 Generation 最多提交一条最终 Assistant Message。

模型调用开始后不做隐式自动 retry，避免重复扣费和不可见的重复回答。失败后由用户显式重新生成。

### 事件订阅与恢复

```text
GET /api/generations/:generationId/events
Last-Event-ID
→ Redis Stream cursor
→ SSE
→ Browser reducer
```

SSE Handler 只负责鉴权、读取、heartbeat 和编码，不运行 LLM、RAG、Tool、coalescing 或 UI throttle。

首次消费从 stream beginning 开始；自动重连从 `Last-Event-ID` 之后继续。页面刷新时：

1. 浏览器获取 Chat Detail
2. 服务端从 PostgreSQL 返回 `activeGeneration: { id, status } | null`
3. 存在 Active Generation 时，浏览器使用该 ID 重新建立 EventSource

浏览器不得根据 Redis、本地缓存、旧连接或 UI 残留状态猜测 Active Generation。首次消费和恢复使用同一 endpoint 与同一事件协议，不增加 Snapshot Stream 或 recovery 专用协议。

### 终态语义

公开 terminal event 必须晚于对应的 PostgreSQL durable state：

```text
completed：提交 Assistant Message 和 Generation completed
failed：提交 Generation failed
cancelled：提交 Generation cancelled
↓ transaction 成功
发布对应 terminal GenerationEvent
```

AI SDK 的 finish/error 只是 Worker 内部执行结果，不能直接等同公开 terminal event。

## 7. LLM 与外部依赖边界

### AI SDK

AI SDK Core 只存在于 LLM Execution 边界，用于模型协议适配、streaming、tool calling 和多步 tool loop。禁止让 AI SDK UI 类型、`useChat`、`UIMessageStream` 或 SDK stream protocol 成为系统的领域模型和应用协议。

```text
AI SDK fullStream
→ packages/llm Adapter
→ GenerationEvent 或 Worker 内部 finish/error
```

Adapter 必须小而明确，并有 contract tests。实现 AI SDK 功能时先核对项目实际安装版本的 bundled docs 和 source，不凭模型记忆使用 API。

当前模型配置：

| 配置 | 当前值 |
| --- | --- |
| Chat Model | GPT-5.6 Sol |
| Provider | CatAPI OpenAI-compatible relay |
| Base URL | `https://maomiapi.com/v1` |
| Provider model ID | `gpt-5.6-sol` |

密钥只通过服务端环境变量注入，不写入仓库、浏览器 bundle、日志或文档。

### Tool 与 MCP

LLM Tools 必须能由 Worker 独立执行。当前不支持浏览器执行 Tool，也不支持 Human-in-the-loop pause/resume。

Tool Registry 负责本地 Tool、联网搜索与 Model Context Protocol（MCP）工具的统一暴露；协议编排优先使用 AI SDK 已有能力，不自研通用 Tool Calling engine。

### Retrieval 与知识入库

Chat 上层只依赖 Retrieval abstraction。Pinecone 是可替换的基础设施 Adapter，不得把其类型、filter DSL 或 SDK 对象泄漏到 Chat、Generation 和 Tool 主链。

系统主动检索和模型自主 Knowledge Search Tool 是两种触发方式，可以共享 Retrieval 服务，但不能混为一个隐式流程。

文档解析、切块、embedding 和向量写入属于独立 Knowledge Ingestion job，不在聊天请求中顺手执行。

### Attachment 与 Context Builder

Generation 只依赖 attachment ID。文件存储、模型原生 file ID、转文本和图片输入策略由 Attachment/File 边界决定，不泄漏 provider-specific 结构。

Context Builder 统一组合 Summary、近期 Messages、Retrieval 结果和 Attachments。Summary 必须记录 coverage watermark，例如 `throughSequence`，避免重复或遗漏上下文。Token Budget 属于当前模型运行配置，不使用全局固定常量假设所有模型。

## 8. 前端状态与流式性能

前端同时维护两种状态：

- PostgreSQL 返回的 durable Completed Messages
- 当前 Generation events 投影出的临时 Projection

收到 `generation.completed` 后，前端重新读取 PostgreSQL Messages 并移除临时 Projection。实时事件不能直接修改永久消息缓存并把自己当成数据库事实。

性能处理分两层：

- Worker 在写 Redis 前进行 lossless delta coalescing，减少事件数量，不丢字符、不改变顺序
- 浏览器按帧调度 reducer 结果写入 React，网络事件频率不直接驱动 React render

这两层解决不同问题，不能用 debounce 取代，也不能因虚拟列表存在而省略。

## 9. 产品行为约束

面向用户的界面只呈现产品信息与操作反馈，不展示架构、技术栈、开发进度或教学式说明。

### Regenerate

Regenerate 只针对最后一条 Assistant Message，并创建新的 Generation。运行时可以隐藏旧回答，但不能提前删除：

- 新回答成功：在 PostgreSQL transaction 中删除旧 Assistant Message 并写入新回答
- 新回答失败或取消：保留旧回答

当前不支持任意历史 User Message 编辑、Conversation Branch、回答版本树或多个 selected/superseded 回答。

### Cancel

取消链路为 `API → durable cancelled state → Worker abort/cleanup → generation.cancelled`。是否永久保存已经生成的 partial Assistant Message 尚未决定，不能从 `cancelled` 事件自行推断。

### Delete Conversation

删除后停止该 Conversation 的新命令，并使正在执行的 Generation 结束。具体软删或硬删策略随数据库模型讨论，但不能留下仍可继续写入的孤立 Worker。

### Share

分享使用独立、不可变的 durable snapshot：

- 只复制 terminal 状态下的 Completed Messages
- 有 Active Generation 时不允许创建分享
- 公共页面不依赖 Redis、BullMQ、SSE 或当前 Generation Projection

### 多 Tab

数据库的单 Active Generation 约束是最终仲裁。其他 Tab 通过 Chat Detail 获取当前 Generation 并订阅同一 SSE 链路，不另建浏览器间一致性协议。

### Image

Chat 与 Image 共享账户、Conversation 外壳和基础设施，但拥有独立业务管线。图片生成不得作为 Chat Worker 中不断扩张的条件分支。

## 10. Auth 与安全边界

Web、API 与 SSE 保持同源。认证使用 Better Auth 的 email/password 和存放在 PostgreSQL 的 Session，通过 HttpOnly Session Cookie 识别用户；原生 EventSource 自然携带同源 Cookie。当前不接入社交登录。

禁止：

- 在 EventSource URL 中携带 token
- 以 localStorage JWT 作为主认证方案
- 把 relay/API key 返回浏览器
- 只靠前端隐藏按钮实现 ownership

## 11. 正常运行假设与非目标

当前只保证 PostgreSQL、Redis、BullMQ、Worker 和上游模型服务正常可用时的执行顺序、输入校验、权限、持久化和可测试性。

支持：

- 客户端断线后通过 Redis Stream 重放
- 页面刷新后通过 PostgreSQL 找回 Active Generation
- 用户显式 Cancel、Regenerate 和 Retry
- 实际把 Web、Worker、PostgreSQL 与 Redis 作为独立进程运行，验证 runtime 分离

不承诺：

- Worker 崩溃后的 provider token stream 精确续传
- PostgreSQL 与 Redis/BullMQ 跨系统半成功后的自动补偿
- Redis、PostgreSQL 或队列故障自愈
- 高可用、自动扩容和生产级容灾
- 模型开始生成后的自动 AI retry

这些能力只有在真实需求出现并经开发者确认后才设计，不提前预留通用框架。

## 12. 工程质量约束

- Route Handler 保持短小，但不为每个操作机械创建 controller/service/repository/interface
- 只在存在真实替换点或测试边界时抽象接口
- 新增依赖前说明用途，优先使用成熟基础设施，不重写 BullMQ、AI SDK 或认证系统
- 数据库 schema 必须能通过 migration 从空库复现，并以数据库约束保证关键不变量；当前开发数据均可丢弃，schema 变更不承担历史数据兼容、迁移或双写，必要时直接重建数据库与 migration 基线
- 修改跨边界协议时，同一轮更新 Schema、类型、fixtures、contract tests 和消费者
- 关键领域规则、EventStore、LLM Adapter 与完整主链需要相应层级的测试
- 日志使用 `generationId` 等稳定关联 ID，不记录密钥或不必要的完整敏感输入
- 目录和 package 数量随真实代码增长，不提前搭建空架构
- 任何“简化”如果会删除 Worker、Redis Event Log、自有协议、关键测试或 V1 核心能力，必须先说明损失并取得确认

## 13. 已确认的核心决策

以下决定不得由 Codex 在实现中自行绕过：

1. V1 只读参考，V2 独立实现
2. Conversation mode 创建后不可变
3. 产品层不支持聊天模型动态切换
4. Web/API 与 Worker 生命周期分离
5. 自有 Message、Generation 与 GenerationEvent 协议
6. `packages/contracts` 是跨 runtime wire contract 的唯一入口
7. PostgreSQL 是 Completed Message 的永久事实来源
8. BullMQ 负责任务，Redis Streams 负责短期事件重放
9. Redis Stream ID 默认直接映射 SSE ID/cursor
10. POST command 与 GET SSE subscription 分离
11. Chat Detail 返回服务端确认的 Active Generation
12. 同一 Conversation 最多一个 Active Generation
13. `userMessageId` 执行最小幂等与明确冲突语义
14. terminal event 必须晚于 PostgreSQL durable state
15. AI SDK 只位于 LLM 执行防腐层
16. Worker 执行 Tool，当前不做浏览器 Tool 和 Human-in-the-loop
17. Retrieval 隔离 Pinecone，Knowledge Ingestion 独立运行
18. 服务端 coalescing 与客户端按帧渲染同时保留
19. Regenerate 成功后才替换旧回答
20. Share 使用独立不可变快照
21. Chat 与 Image 使用独立业务管线
22. 同源 HttpOnly Session Cookie 是主认证边界
23. 当前不建设基础设施故障自动恢复系统
24. 使用本文确认的 UI、表单、状态、数据、Markdown 与容器技术栈，但版本和局部配置按实际代码决定

## 14. 尚未拍板的问题

这些问题在真实代码需要它们时讨论，不预先排期：

1. ORM/DB layer
2. Image Model
3. Redis Stream TTL
4. delta coalescing 的时间与大小阈值
5. BullMQ concurrency
6. cancel signal 的跨进程实现
7. Cancel 后 partial Assistant Message 是否持久化
8. object storage
9. embedding provider、Chunk Strategy 与 Pinecone index schema
10. 是否持久化完整 Tool input/output
11. reasoning 的展示形态
12. 最终部署拓扑

## 15. 协作规则

固定节奏：

```text
讨论下一小步
→ 开发者明确说“开干”
→ Codex 实现、验证并更新必要文档
→ 停在未提交状态供开发者研读
→ 开发者明确说“提交”
→ Codex commit 并 push 到 GitHub
→ 讨论下一小步
```

“提交”同时表示 commit 与 push，只覆盖已经研读确认的当前改动，不授权自动开始下一轮。

每轮工作遵守以下规则：

- 开工前阅读本文档、当前代码和相关 V1 行为
- 每轮只处理一个清晰范围，避免一次生成大量难以研读的代码
- 实现后运行与风险相称的验证，并清楚报告未验证内容
- 未经开发者明确确认，不修改架构决定，不提交，不推送
- 发现文档、代码和新需求冲突时先讨论，不偷偷兼容
- 架构文档只保留稳定约束；局部方案随代码见机决定
