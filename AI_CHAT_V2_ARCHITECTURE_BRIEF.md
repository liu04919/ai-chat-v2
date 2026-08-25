# AI Chat V2：架构重构背景、决策与 Codex 实施约束

> **用途**：这是给 Codex 的架构上下文与实施约束文档。
>
> **旧项目**：`D:\code\Next\ai-chat`
>
> **重要原则**：旧项目保留为 V1，不在原仓库里做大规模重构。V2 应新建项目，从零实现。旧项目只作为“需求库、历史实现参考、反例库”来阅读。
> **优先级**：这是一个求职项目。首先考虑 **功能完整度、架构深度、复杂度控制、简历可写性、面试可解释性**，第一阶段先保证正常运行路径清晰、可运行、可测试，不为暂不考虑的基础设施故障堆叠生产级复杂度。

## 文档地位与动态更新规则

本文档是 V2 **当前时点的架构 Source of Truth**，但不是冻结后永远不可修改的圣经。代码必须服从开发者明确拍板并记录到本文档的架构决策，不能因为某个实现已经写完或测试通过，就反过来把实现偶然性升级为设计。

后续优先级如下：

```text
开发者最新明确拍板的架构决策
>
本文档记录的当前架构决策与 Hard Constraints
>
已经验证的实际代码与运行行为
>
V1 的历史实现
```

每次实现、验证或讨论产生新结论后，都必须同步更新本文档对应章节：

- 新决策如果推翻旧决策，直接重写旧章节，不要只在文末追加互相冲突的补丁说明；
- 代码只能证明“当前实现是什么”，不能自动决定“架构应该是什么”；
- 已落地代码与当前架构决策冲突时，先视为实现偏差。Codex 必须停止扩散该偏差并说明冲突，不得自行修改文档迁就代码；
- 如果实现暴露了新的真实约束，Codex 可以提出设计调整；只有开发者明确拍板后，才能同时修改架构约束、相关正文与代码；
- Codex 可以自行更新实现进度、验证结果和不改变设计的事实描述；修改架构决策或 Hard Constraints 必须得到开发者明确确认；
- 上下文压缩或开启新对话后，仍应先读取本文档，但必须把它视为持续维护的项目记录；
- 不要因为“未来也许需要”提前加入当前需求没有要求的可靠性机制。

---

## 0. 给 Codex 的一句话

不要把 V2 写成“换了文件夹结构的 V1”。

V2 的核心目标是：

1. 砍掉多模型动态切换造成的组合爆炸；
2. 不再让 AI SDK UI/message/stream 协议成为整个系统的骨架；
3. 自己掌控 ChatMessage、Generation、前后端事件协议、SSE、断线恢复、持久化与渲染性能；
4. AI SDK 只作为 **LLM Execution Engine**，负责厂商协议适配、Tool Calling 和 Multi-step Tool Loop；
5. 用 BullMQ Worker 解耦 HTTP 请求生命周期与长时间 AI Generation；
6. 用 Redis Streams 保存短生命周期 Generation Event Log，并通过原生 EventSource + `Last-Event-ID` 做统一实时消费与恢复；
7. RAG 是独立 Retrieval 能力，Pinecone 只是当前实现，绝不允许 Pinecone 细节侵入 Chat/Tool/Generation 主链路。

第一阶段默认 PostgreSQL、Redis、BullMQ 与 Worker 正常可用，只保证正常路径的状态顺序正确。Outbox、分布式事务、跨存储补偿、自动故障恢复和复杂重试都不是当前目标。

如果某个实现违反这些原则，不要“先写出来再说”，应先指出冲突。

## 0.1 复杂度取舍原则

V2 不是 Demo，也不是把所有逻辑重新塞回一个 Next.js Route。为了主链路、功能完整度和可解释架构而产生的复杂度必须保留：

- Web/API 与长期运行 Worker 的 runtime 分离；
- 自己定义 Domain Model 和 GenerationEvent Protocol；
- PostgreSQL 永久状态、BullMQ 任务、Redis Streams 事件日志的职责分离；
- SSE replay、前端 Projection、服务端 coalescing 和客户端 render scheduling；
- AI SDK、Gateway、Pinecone 等外部依赖的清晰 Adapter 边界；
- 数据库约束、鉴权、输入校验、迁移、关键协议测试和必要日志。

这些都是正常业务和架构目标直接需要的工程深度，不应以“简单”为理由删除。

当前主动砍掉的是另一类复杂度：为了 PostgreSQL、Redis、BullMQ、Worker 宕机或跨系统半成功而建设的 Outbox、分布式事务、自动补偿、故障自愈和复杂重试。它们不影响正常主链路的设计质量，但会明显增加当前学习和实现成本。

同样不应无理由引入微服务、CQRS、通用 Event Bus、依赖注入容器或与当前需求无关的泛型框架。判断标准不是“文件越少越好”，而是每层边界都能对应真实职责，每项复杂度都能解释其收益。

---

# 1. 为什么要做 V2

## 1.1 V1 的历史背景

V1 开始开发时，开发者几乎没有后端经验，对 SSE、Fetch + ReadableStream、数据库历史消息、流恢复、Tool Calling、MCP、RAG 等概念都还没有形成自己的心智模型。

项目早期很大程度参考了另一个优秀 AI Chat 项目的设计思路，并大量依赖 AI 辅助开发。开发期间又频繁更换模型、账号和上下文，导致：

- 不同 AI 在不同阶段使用了不同工程理念；
- 前后决策缺乏统一架构约束；
- 新功能往往是在旧假设上追加兼容层；
- 技术债逐渐形成后，后续开发只能继续绕着已有复杂度走。

V1 并不是“没功能”。相反，它已经具备多模型、流式聊天、RAG、MCP、联网搜索、文件处理、游标分页、流恢复等很多能力。

问题是：

> 功能很多，但多个设计世界观叠加在一起，系统的 Source of Truth、协议边界和职责边界逐渐模糊。

因此 V2 不是简单重构，而是一次利用当前认知重新设计系统边界的 Greenfield Rewrite。

---

# 2. 如何看待旧项目

## 2.1 不要否定 V1

V1 的价值有三个：

1. **需求库**：它已经证明哪些功能是真正想保留的。
2. **问题库**：很多 V2 架构决策正是从 V1 的痛点中推导出来的。
3. **对照组**：未来可以清晰比较“为什么 V2 这样设计”。

因此 Codex 在实现 V2 前，应该阅读 V1，而不是复制 V1。

重点观察以下位置：

- `src/app/api/chat/route.ts`
- `src/lib/active-chat-streams.ts`
- `src/lib/model.ts`
- `src/app/(chat)/chat/[chatid]/page.tsx`
- `src/app/api/chat/util.ts`
- `src/app/api/chat/summary.ts`
- `src/hooks/useSnapshotMessageBuffer.ts`
- `src/hooks/useStreamBuffer.ts`
- `src/hooks/api/useMessages.ts`
- `src/app/api/extract/route.ts`
- `src/lib/mcp-tools.ts`
- `src/lib/web-search.ts`
- `src/app/api/chats/[chatId]/share/route.ts`
- `src/app/share/[token]/page.tsx`
- `src/lib/share.ts`

## 2.2 V1 中最值得理解的几个问题

### A. `/api/chat/route.ts` 成为了 God Route

当前 route 同时承担：

- 鉴权；
- Chat 创建；
- User Message 持久化；
- regenerate；
- DB Context 加载；
- token/context 管理；
- RAG；
- Web Search Tool；
- MCP Tool；
- Prompt；
- 模型配置；
- Provider 分支；
- reasoning 配置；
- `streamText()`；
- AI SDK UI Stream；
- assistant message 保存；
- active stream 注册。

这说明 HTTP、业务编排和外部依赖调用已经混在一起。

V2 中 Route Handler 只负责 Transport 与鉴权，业务编排进入 Application Service，长时间生成进入 Worker。Domain、Application、Infrastructure 的依赖方向要清楚，但不要求每个简单操作都机械复制完整五层模板。

### B. 多模型导致组合爆炸

V1 的 `model.ts` 中已经同时存在：

- provider；
- `supportsVision`；
- `supportsThinking`；
- `supportsWebSearch`；
- `webSearchMode`；
- `fileStrategy`；
- 不同 provider options；
- Image Model；
- Chat Model。

这类问题不是“if 写得不好”，而是 **combinatorial explosion / state-space explosion / conditional complexity**：

```text
模型
× 思考能力
× 联网能力
× 视觉能力
× 文件策略
× Tool Calling
× RAG
× Provider 特殊参数
× 生图
...
```

每增加一个维度，系统潜在状态空间就变大。

V2 的策略不是继续抽象一个“超级多模型平台”，而是主动收缩问题域。

### C. 消息 Source of Truth 不清晰

V1 前端逐渐同时存在：

- DB 分页历史；
- AI SDK `useChat` messages；
- streaming assistant message；
- snapshot recovery message；
- image pending message；
- merge/dedupe。

这使“页面当前看到的一条消息到底来自哪里”变得复杂。

V2 必须明确：

> PostgreSQL 是 Completed Message 的永久 Source of Truth。
>
> 前端只允许存在一个短生命周期的 Current Generation Projection。

### D. 正常流与恢复流是两套链路

V1 `active-chat-streams.ts` 中：

- 正常 UIMessageChunk 流；
- snapshot SSE 流；
- `ReadableStream.tee()`；
- in-memory `Map`；
- latest assistant snapshot；
- snapshot subscriber；
- normal subscriber。

它是一个有创造性的演进方案，但结果是正常消费和恢复消费具有不同协议和状态模型。

V2 的核心目标之一：

> **实时流和恢复流不再是两个概念。**

它们都是“从某个 Event Cursor 开始读取 Generation Event Log”。

## 2.3 V2 必须可验证地优于 V1

V2 不能以“控制复杂度”为理由退化成功能缩水的玩具项目。V1 已经实现的有价值能力仍是 V2 的需求库：流式聊天、历史分页、断线恢复、Tool/MCP、联网搜索、RAG、文件、分享与独立 Image Pipeline 应按阶段重新实现。

V2 至少要在以下方面明确优于 V1：

1. Route Handler 不再承担整条生成链路，Web 与 Worker 生命周期真正分离；
2. ChatMessage、Generation 和 GenerationEvent 是自己的领域与应用协议，不被 AI SDK UI 类型控制；
3. 正常实时消费与断线恢复共用 Redis Event Log + SSE 协议，不再维护 in-memory snapshot 双链路；
4. 页面状态收敛为 PostgreSQL Completed Messages + Current Generation Projection；
5. Regenerate、Cancel、Delete、Share 都有明确且可测试的业务语义；
6. Gateway、AI SDK、Pinecone、MCP 都被限制在清晰 Adapter/Registry 边界；
7. Context Builder、Summary 水位线、Retrieval 和 Attachment 各有清晰职责；
8. 协议映射、状态 reducer、数据库约束和关键用例有自动化测试；
9. 流式性能优化有测量依据，不靠散落在组件里的临时 throttle；
10. 代码能从入口沿调用链阅读和解释，而不是把 V1 God Route 换成一个 God Worker 或 God Service。

如果 V2 最终只是删掉 V1 功能、减少文件，或把复杂度换一个地方堆放，即使能运行也不算成功。

---

# 3. V2 架构思想是怎么推导出来的

这一节非常重要。不要只知道“最终要这么写”，还要知道为什么。

## 3.1 第一步：砍掉用户动态多模型切换

最初考虑继续支持：

```text
DeepSeek → Kimi → Qwen → 生图模型 → 再换回来
```

但不同模型支持不同能力，必然导致大量 Provider/Capability 分支。

而多模型适配本身对求职项目的投入产出比并不高：

- 写起来复杂；
- 测试矩阵大；
- 很容易让 Provider 特性泄漏；
- 简历上最后通常只有一句“支持多模型”。

因此 V2 决定：

### Conversation 创建时确定 Mode，之后不可修改

```ts
type ConversationMode = "chat" | "image";
```

两条业务链独立：

```text
Chat Pipeline
Image Pipeline
```

它们可以共享：

- auth；
- user；
- database；
- object storage；
- 基础 UI；
- conversation shell。

但不共享业务生成链路。

这体现：

> **Make illegal states unrepresentable.**

不要用大量 if 去禁止“Chat 中途切 Image”，而是数据模型和路由本身就不允许这种状态出现。

---

## 3.2 第二步：产品层不再暴露多 Chat Model

Chat 模式只使用一个主模型。

具体模型可以通过服务端部署配置替换，但：

- 前端不提供 model selector；
- Chat 数据模型不围绕 `modelKey` 设计；
- Provider 不是业务概念；
- UI 只暴露真正需要的能力，例如 reasoning effort。

例如：

```ts
type ReasoningEffort = "low" | "medium" | "high";
```

这与“内部可以替换模型实现”并不冲突。

即：

> 技术上可替换，业务上不动态切换。

当前主 Chat Model 已确定为 **GPT-5.6 Sol**，当前调用渠道已确定为 **CatAPI OpenAI-compatible relay**。

当前运行时链路：

```text
Generation Worker
↓
AI SDK Core
↓
OpenAI-compatible Provider Adapter
↓
CatAPI
↓
gpt-5.6-sol
```

CatAPI 仍然只属于 **LLM Infrastructure**。前端、Chat Domain、Generation Domain、Context Builder、Tool、RAG、Redis Event Protocol 都不得依赖中转站的专有类型、路由细节或模型命名规则。

未来如果切换到 OpenAI 官方 API、Vercel AI Gateway、OpenRouter、Azure、Bedrock 或其他兼容渠道，原则上只允许影响 LLM runtime/config/adapter 边界。

---

## 3.3 第三步：前端和应用协议不再交给 AI SDK

V1 大量依赖：

- AI SDK UI Message；
- `useChat`；
- AI SDK stream protocol；
- UIMessageChunk；
- AI SDK 自己的恢复语义。

V2 希望把最适合求职项目深入讲解的部分自己掌握：

- ChatMessage；
- Generation；
- 前后端协议；
- SSE；
- Event ID；
- `Last-Event-ID`；
- Redis replay；
- 前端 projection/reducer；
- streaming render performance。

于是产生了一个问题：

> Tool Calling 很复杂。如果不用 AI SDK，是否需要自己重写 Tool Calling / Multi-step loop？

答案：不需要。

---

## 3.4 第四步：AI SDK 只用 Core，不用 UI

最终边界：

> **AI SDK 管 LLM Runtime，我们管 Application Protocol。**

AI SDK 仅负责：

1. Provider 协议归一化；
2. Tool Schema / Tool Calling；
3. Tool execution；
4. Multi-step generation；
5. `streamText()` / `fullStream`。

禁止 AI SDK UI 类型越过 LLM Infrastructure 边界。

不要使用 AI SDK UI 作为系统领域模型：

- 不把 `UIMessage` 存数据库；
- 不把 `UIMessageChunk` 直接推浏览器；
- 不用 `useChat` 作为 Chat 状态核心；
- 不用 `toUIMessageStreamResponse()` 定义应用协议。

AI SDK 在 V2 中的定位应类似：

```text
pg client
Redis client
BullMQ
AI SDK Core
```

它是基础设施依赖，不是项目架构。

---

## 3.5 第五步：发现 SSE GET 场景可以天然恢复

传统 Chat 常见：

```text
POST /chat
↓
fetch()
↓
ReadableStream
```

理由是 EventSource 只能 GET，而发送消息必须带 POST body。

但这里有一个之前默认却并非必要的假设：

> “提交一次生成”和“持续消费生成结果”必须发生在同一个 HTTP Request。

把它们拆开：

```text
POST = Command
GET SSE = Subscription
```

于是：

```text
POST /api/chats/:chatId/generations
→ 返回 generationId

GET /api/generations/:generationId/events
→ EventSource
```

第一次消费和断线恢复从此使用完全相同的 GET Endpoint。

这不是为了标新立异，而是因为问题已经从：

> 一次 POST 中如何流式返回结果

升级为：

> 如何让 Generation 成为独立、可订阅、可重放的长生命周期任务。

---

## 3.6 第六步：Redis Streams 与 SSE ID 天然对应

每次 Generation 有短生命周期 Event Log：

```text
generation:{generationId}:events
```

事件写入 Redis Stream。

Redis Stream entry ID 可直接作为：

```text
Redis Stream ID
=
SSE id
=
resume cursor
```

浏览器正常重连时：

```http
Last-Event-ID: <last-id>
```

SSE Handler 从该 cursor 之后继续读取 Redis。

因此系统不需要：

```ts
isRecoveryMode
```

只需要：

> consumer 想从哪个 cursor 开始读。

刷新页面时新的 EventSource 不会自动拥有旧实例的 `Last-Event-ID`。第一版可以直接从当前 generation 的第一个事件重放，重新构建 Projection。不要第一版引入 Snapshot + Event 双系统。

---

## 3.7 第七步：POST 返回后谁继续生成？

如果 POST 很快返回 `generationId`，而 GPT 可能执行几十秒、Tool Calling 甚至几分钟，就产生生命周期问题。

尤其不能依赖 Serverless Handler 返回后继续偷偷跑 Promise。

因此进一步引入：

> **BullMQ + 独立 Node Worker**

HTTP 请求只负责创建任务和入队。

AI Worker 负责真正执行 Generation。

这样三个生命周期解耦：

```text
HTTP Request 生命周期
AI Generation 生命周期
SSE Consumer 生命周期
```

这是一个真实需求，不是为了堆技术栈。

---

## 3.8 第八步：Throttle 拆成两个不同问题

不能用一个“throttle”概念把所有性能问题混在一起。

### 服务端：Delta Coalescing

AI SDK raw delta 可能很碎：

```text
"你" "好" "，" "我" "是"
```

Worker 在写 Redis 前合并连续同类 delta：

```text
"你好，我是"
```

目的：

- 减少 Redis XADD；
- 减少 Stream entry；
- 减少 SSE event；
- 降低 replay 成本；
- 降低网络事件数量。

它不是丢事件的 throttle，而是 **lossless coalescing**。

遇到语义边界必须立即 flush：

- text → tool；
- reasoning → text；
- tool event；
- completed；
- failed；
- cancelled。

### 前端：Render Scheduling

网络事件频率不能直接决定 React render 频率。

前端使用：

```text
EventSource
↓
mutable pending projection
↓
requestAnimationFrame
↓
React commit
```

目的：

- 降低 React reconciliation；
- 降低 Markdown 重算；
- 保护主线程。

服务端优化事件存储/传输，客户端优化 UI rendering。两者不重复。

---

## 3.9 第九步：AI SDK 和我们的协议之间必须有防腐层

AI SDK `fullStream` 可能包含很多内部事件：

- text start/delta/end；
- reasoning start/delta/end；
- tool input streaming；
- tool call/result；
- step；
- finish；
- error；
- provider metadata；
- 等。

我们绝不全盘接受。

要建立一个小型：

> **AI SDK Anti-Corruption Layer / Generation Adapter**

它只取应用需要的语义事件。

AI SDK 世界改变时，只改 Adapter。

Redis/SSE/Frontend/PostgreSQL 不知道 AI SDK 发生过版本变化。

---

## 3.10 第十步：RAG 也必须做同样的防腐

当前 V1 使用 Pinecone。

V2 不应该把：

```text
Pinecone namespace
Pinecone query
Pinecone filters
vector dimension
index host
```

泄漏到：

- Generation Worker；
- Context Builder；
- Tool；
- Chat Route。

因为未来有计划在时间允许时自己实现/替换向量检索。

所以：

> **RAG 是 Retrieval Capability，不是 Pinecone。**

Pinecone 只是当前 `VectorStore` / `Retriever` Adapter。

---

# 4. V2 总体架构

```text
                         ┌────────────────────┐
                         │     PostgreSQL     │
                         │                    │
                         │ Chat / Message     │
                         │ Generation         │
                         │ Share Snapshot     │
                         │ KB metadata        │
                         └─────────▲──────────┘
                                   │
                                   │ durable state
                                   │
┌───────────────┐      POST        │
│    Browser    │ ───────────────► ┌─────────────────────┐
│               │                  │    Next.js Web/API  │
│ React UI      │ ◄─────────────── │                     │
└──────┬────────┘  generationId    │ Command + SSE edge  │
       │                           └─────────┬───────────┘
       │                                     │ enqueue
       │                                     ▼
       │                           ┌─────────────────────┐
       │                           │ BullMQ / Redis      │
       │                           │ Generation Queue    │
       │                           └─────────┬───────────┘
       │                                     │
       │                                     ▼
       │                           ┌─────────────────────┐
       │                           │ Generation Worker   │
       │                           │                     │
       │                           │ Context Builder     │
       │                           │ Retrieval / RAG     │
       │                           │ Tools / MCP         │
       │                           │ AI SDK Core         │
       │                           └─────────┬───────────┘
       │                                     │ fullStream
       │                                     ▼
       │                           ┌─────────────────────┐
       │                           │ AI SDK ACL Adapter  │
       │                           └─────────┬───────────┘
       │                                     │
       │                                     ▼
       │                           ┌─────────────────────┐
       │                           │ Delta Coalescer     │
       │                           └─────────┬───────────┘
       │                                     │
       │                                     ▼
       │                           ┌─────────────────────┐
       │                           │ Redis Streams       │
       │                           │ Generation Events   │
       │                           └─────────┬───────────┘
       │                                     │
       │ GET SSE / EventSource               │ XREAD
       └─────────────────────────────────────┘

Browser side:

EventSource
    ↓
GenerationEvent
    ↓
Projection / Reducer
    ↓
rAF Render Scheduler
    ↓
React / Markdown UI
```

---

# 5. 核心领域对象

不要一开始直接套 AI SDK 类型。

至少明确三个不同世界。

## 5.1 ChatMessage

永久业务数据。

```ts
type ChatMessage = {
  id: string;
  chatId: string;
  role: "user" | "assistant";
  content: /* own domain representation */;
  sequence: number;
  createdAt: Date;
};
```

具体 content 是否 parts 化可以后定，但必须是我们的类型。

---

## 5.2 Generation

一次“根据某个用户输入生成 Assistant Answer”的执行实例。

```ts
type GenerationStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
```

Generation 与 Message 不是同一个对象。一次 Generation 最多产生一条最终 Assistant Message；失败或取消时可以没有最终 Assistant Message。

重新生成仍会创建新的 Generation，但业务上采用**替换语义**，不维护多个可选回答：

```text
User Message
├── Generation A → Assistant A（当前回答）
└── Generation B（重新生成中的执行）
```

Generation B 运行期间，Assistant A 继续保留在 PostgreSQL 中，前端可以暂时隐藏它。B 失败或取消时恢复显示 A；只有 B 成功完成时，才在同一 PostgreSQL transaction 中删除 A、写入 B 的 Assistant Message，并把 B 标记为 completed。

第一版不增加 `selected`、`superseded` 或 Conversation Branch。旧 Generation 可以作为执行记录保留，但旧 Assistant Message 被成功替换后不再出现在消息列表或 Context 中。

---

## 5.3 GenerationEvent

描述“生成过程中发生了什么”。

Protocol v1 不要贪多。

建议第一版只考虑类似：

```ts
type GenerationEvent =
  | {
      type: "generation.started";
      generationId: string;
    }
  | {
      type: "reasoning.delta";
      delta: string;
    }
  | {
      type: "text.delta";
      delta: string;
    }
  | {
      type: "tool.called";
      toolCallId: string;
      toolName: string;
      input?: unknown;
    }
  | {
      type: "tool.completed";
      toolCallId: string;
      toolName: string;
      output?: unknown;
    }
  | {
      type: "source.added";
      source: unknown;
    }
  | {
      type: "generation.completed";
      messageId: string;
    }
  | {
      type: "generation.failed";
      code: string;
      message: string;
    }
  | {
      type: "generation.cancelled";
    };
```

**以上只是协议方向，不要求 Codex 未讨论就照抄字段。**

重点是：

- 协议是我们的；
- 事件少而稳定；
- 每个事件自描述；
- 不复制 AI SDK UI Stream 状态机；
- 不要求 `text-start` 才能理解 `text.delta`；
- Tool input partial JSON 第一版不推前端；
- reasoning 是 optional capability，不保证任何模型一定暴露完整思维过程。
- `generation.completed` / `generation.failed` / `generation.cancelled` 都由 Worker 在相应 PostgreSQL 状态写入成功后产生，不由 AI SDK Adapter 直接产生。

实施顺序必须控制协议扩展范围：Phase 5 只实现文字主链需要的 `generation.started`、`text.delta`、可选 `reasoning.delta` 和 terminal 语义；`tool.called`、`tool.completed`、`source.added` 在 Phase 6 接入真实 Tool 后再实现，不提前写无调用方的处理代码。

---

# 6. AI SDK 的严格边界

## 6.1 可以使用

- `streamText`
- tools
- schema
- multi-step tool execution
- `stopWhen`
- `fullStream`
- Provider Adapter

## 6.2 不允许成为系统协议

不要让这些东西进入 application/domain/frontend：

- `UIMessage`
- `UIMessageChunk`
- `useChat`
- AI SDK UI stream protocol
- AI SDK resume metadata
- provider-specific metadata
- AI SDK message IDs 作为业务主键

## 6.3 Adapter 应该足够小

正确方向：

```text
fullStream event
↓
switch
├─ text delta      → text.delta
├─ reasoning delta → reasoning.delta
├─ tool call       → tool.called
├─ tool result     → tool.completed
├─ source          → source.added
├─ finish          → 结束迭代并向 Worker 返回内部 LlmRunResult
├─ error           → 抛给 Worker
└─ 其他             → 明确 ignore
```

这里必须区分：

```text
AI SDK finish
=
LLM execution finished

generation.completed
=
Worker 已完成应用层收尾并成功写入 PostgreSQL
```

Adapter 不要把 finish/error 直接映射成公开 terminal GenerationEvent，也不需要额外向 Redis/Frontend 发送 `model.finished`。正常结束时返回最终结果，异常时抛给 Worker，由 Worker 决定 Generation 的最终状态并发布对应 terminal event。

错误信号：

如果 `ai-sdk-adapter.ts` 逐渐出现：

- 1000+ 行；
- 维护 text-start map；
- 维护 reasoning block lifecycle；
- partial tool JSON parser；
- UI message reconstruction；
- SDK resume state；
- SDK message metadata；
- provider 分支到处外泄；

说明我们正在重新实现 `useChat`，必须停下重新审视边界。

## 6.4 版本策略

AI SDK 版本要 pin。

升级依赖时必须先跑 Adapter Contract Tests。

---

# 7. Generation 创建与 SSE 订阅

## 7.1 创建任务

```http
POST /api/chats/:chatId/generations
```

大致输入：

```json
{
  "message": {
    "id": "...",
    "content": "...",
    "attachmentIds": []
  },
  "reasoningEffort": "high",
  "knowledgeBaseId": "..."
}
```

返回：

```json
{
  "generationId": "gen_xxx"
}
```

POST 只做：

1. auth / ownership；
2. 校验 Conversation 可生成；
3. 持久化 User Message；
4. 创建 `Generation(status=queued)`；
5. BullMQ enqueue；
6. 返回 `generationId`。

不要在 POST Handler 里直接持续跑 GPT。

第一阶段按以上正常顺序实现即可。PostgreSQL 写入和 BullMQ enqueue 之间不引入 Transactional Outbox；如果基础设施恰好在两步之间故障，暂不设计自动补偿或对账机制。

---

## 7.2 订阅事件

```http
GET /api/generations/:generationId/events
```

前端：

```ts
new EventSource("/api/generations/gen_xxx/events")
```

职责：

```text
Last-Event-ID
↓
GenerationEventStore.readAfter(cursor)
↓
SSE encode
↓
client
```

SSE Handler：

- 不运行 GPT；
- 不运行 RAG；
- 不运行 Tool；
- 不做业务事件合并；
- 不做 UI throttle。

它只是 Transport。

---

## 7.3 第一次消费与恢复是同一件事

第一次：

```text
cursor = beginning
```

自动重连：

```text
cursor = Last-Event-ID
```

刷新页面：

第一版可从当前 Generation 的 stream beginning 重放。

不要创建：

```ts
isRecoveryStream
```

不要另起 Snapshot Protocol。

---

## 7.4 Event ID

默认保持直接映射：

```text
Redis Stream ID
=
SSE event id
=
resume cursor
```

除非开发者在讨论后确认存在必须增加映射层的明确理由，否则不得引入第二套 cursor 或 ID 转换规则。

读取语义必须是：

> strictly after last received event id

避免 delta 重复 append。

---

## 7.5 Heartbeat

Tool/RAG 可能几十秒不产生 token。

SSE Handler 应周期性发送：

```text
: heartbeat
```

它是纯 Transport keep-alive：

- 不进 Redis；
- 不进 GenerationEvent；
- 不进 reducer。

## 7.6 第一阶段的一致性边界

当前只要求依赖正常可用时的执行顺序清楚：

```text
POST
↓
PostgreSQL: User Message + Generation(queued)
↓
BullMQ enqueue
↓
返回 generationId

Worker
↓
Generation(running)
↓
AI SDK + Redis streaming events
↓
PostgreSQL: Assistant Message + terminal Generation status
↓
Redis terminal event
```

某一步失败时先让请求或 Generation 明确失败并记录错误，不为“恰好在两个存储步骤之间宕机”设计自动修复系统。第一阶段不加入 Outbox、分布式事务、跨存储补偿或后台对账任务。

---

# 8. BullMQ Worker

## 8.1 为什么需要 Worker

Generation 可能持续几十秒甚至更久，而 POST 创建请求只应该持续很短。

不要把长任务生命周期绑定到 HTTP Handler。

更不要依赖 Serverless Handler 返回 Response 后后台 Promise 还能可靠运行。

因此：

```text
Next API
↓
BullMQ
↓
Node Worker
```

Worker 是长期运行的 Node/TypeScript 进程，不是新的语言栈。

---

## 8.2 BullMQ 负责什么

BullMQ 负责：

- Queue；
- Worker；
- Job dispatch；
- concurrency；
- stalled job；
- 基础失败处理。

我们不要自己手搓 Redis `LPUSH/BRPOP` 来重新发明低配任务队列。

---

## 8.3 BullMQ 不等于 Redis Event Stream

两者职责完全不同。

```text
BullMQ
=
“谁来执行 gen_123？”
=
Job lifecycle
```

```text
Redis Streams
=
“gen_123 执行过程中发生了什么？”
=
Event log / replay
```

不要使用 BullMQ 内部 key 当业务协议。

不要用 QueueEvents 代替 GenerationEventStore。

---

## 8.4 最小重复执行保护

这里只做两条容易理解的保护，不建立通用可靠性框架：

`generationId` 必须贯穿：

```text
HTTP
PostgreSQL
BullMQ Job
Worker
Redis Event
Assistant Message
Logs
```

1. 使用 `generationId` 作为 BullMQ `jobId`；
2. Worker 开始前确认 Generation 仍是 queued，并保证一个 Generation 最多写入一条最终 Assistant Message。

另外：

- 在真正调用模型之后，不进行自动 AI retry；
- 如果 Worker 仍在运行且能捕获模型调用错误，Generation → failed；
- 用户显式“重新生成”会创建新的 Generation；
- 不偷偷后台再次扣费生成。

不要再围绕这两条规则扩展通用幂等框架、补偿任务或状态修复系统。

---

# 9. 一个 Chat 只允许一个 Active Generation

第一版硬约束：

> 同一个 Conversation 同一时刻最多一个 queued/running Generation。

否则会产生：

- 两个 Worker 使用不同上下文；
- Assistant 完成顺序错乱；
- Context Builder 不知道未完成回答算不算历史；
- 多 Tab race。

必须由服务器/数据库保证，不能只靠前端 disabled。

生成中 UI 可以把发送按钮变成 Stop。

---

# 10. Regenerate 与 Conversation Branch

## 10.1 支持

支持对最后一条 Assistant Message 重新生成，采用破坏性替换语义，但不提前删除旧回答：

```text
Assistant Message A（当前 durable 回答）
↓ 用户点击重新生成
Generation B running
├─ failed/cancelled → A 继续保留并恢复显示
└─ completed
   ↓ PostgreSQL transaction
   ├─ DELETE Assistant Message A
   ├─ INSERT Assistant Message B
   └─ UPDATE Generation B = completed
```

生成期间前端可以暂时隐藏 A，让用户看到“正在替换”的状态。只有新回答 B 已完整生成并准备持久化时才删除 A，因此失败或取消不会让用户丢失原答案。

业务消息列表和 Context 始终只有一个当前回答，不增加多版本选择、`selected` / `superseded` 状态或回答分支。

## 10.2 第一版不支持

不要支持：

> 编辑任意历史 User Message 后从中间重新生成。

否则线性 Chat 会升级为 Conversation Tree：

```text
U1
↓
A1
↓
U2
├─ A2a → U3a
└─ A2b → U3b
```

随后：

- pagination；
- summary；
- context；
- RAG；
- branch selection；

全部必须分支感知。

这是 V3 级复杂度，V2 第一阶段明确不做。

---

# 11. PostgreSQL 与 Redis 的职责

## PostgreSQL

永久业务事实：

- User；
- Conversation；
- Message；
- Generation；
- immutable Share Snapshot；
- Knowledge Base metadata；
- Document metadata；
- Tool execution record（如决定保存）。

## Redis / BullMQ

待执行任务。

## Redis Streams

短生命周期 Generation Event Log。

Redis Stream 不是第二套永久数据库。

Generation 完成后 Event Stream 可设置 TTL / 清理策略。

历史页面永久消息应从 PostgreSQL 读取。

---

# 12. `generation.completed` 的严格语义

这是重要一致性约束。

错误顺序：

```text
GPT finish
↓
Redis generation.completed
↓
前端刷新 Messages
↓
DB 还没写 assistant
```

会重新制造 merge/retry/dedupe 技术债。

正确顺序：

```text
GPT finish
↓
flush DeltaCoalescer
↓
构造最终 Assistant Message
↓
PostgreSQL transaction:
    普通生成：INSERT assistant message
    重新生成：DELETE old assistant + INSERT new assistant
    UPDATE generation = completed
COMMIT
↓
Redis:
    generation.completed
```

因此：

> **`generation.completed` 不是“模型不再吐 token”。**
>
> **它表示这次 Generation 已经成功变成 durable business state。**

前端收到 `generation.completed` 后，可以安全刷新 DB messages 并销毁 Current Generation Projection。

同理：AI SDK Adapter 抛出 error 或收到 abort，只代表执行层出现异常或停止。Worker 先把 Generation 写成 failed/cancelled，成功后再发布对应 terminal event。

以上是**正常运行路径下的顺序语义**，不承诺 PostgreSQL commit 后 Redis 恰好故障时仍能自动补发 terminal event；第一阶段不为这种跨系统故障引入 Outbox 或补偿流程。

---

# 13. 前端状态模型

不要再出现多个永久/半永久 Message Source。

页面核心：

```text
DB completed messages
+
Current Generation Projection
```

Projection 是临时状态。

流完成后：

```text
generation.completed
↓
invalidate/refetch messages
↓
PostgreSQL 返回最终 Assistant Message
↓
移除 Projection
```

不要：

```text
history
+ useChat
+ snapshot
+ recovery
+ pending
+ Map dedupe
```

---

# 14. 前端渲染性能

## 14.1 事件消费与 React 渲染分离

不要每个：

```text
text.delta
```

直接触发一次 React render。

使用：

```text
EventSource
↓
mutable pending state
↓
requestAnimationFrame
↓
commit projection to React
```

核心原则：

```text
network event frequency
!=
React render frequency
```

---

# 15. 服务端 Delta Coalescing

位置必须是：

```text
AI SDK fullStream
↓
Application Adapter
↓
Delta Coalescer
↓
Redis EventStore
```

不要放在 SSE Handler。

规则：

- 连续 `text.delta` 合并；
- 连续 `reasoning.delta` 合并；
- 时间阈值达到 flush；
- size 阈值达到 flush；
- 任何语义边界前 flush；
- terminal event 前 flush。

具体 20ms/33ms/50ms 不要拍脑袋定死。

应该可配置并通过性能测试决定。

---

# 16. Tool Calling / MCP

## 16.1 为什么保留 AI SDK Core

Tool Calling 真正麻烦的不是“调用一个函数”，而是：

```text
LLM
↓
tool call
↓
tool execution
↓
tool result
↓
LLM next step
↓
another tool
↓
...
↓
final answer
```

还涉及：

- schema；
- tool call id；
- multiple tool calls；
- errors；
- multi-step；
- stop condition；
- provider format difference。

这些属于成熟基础设施解决的问题。

我们不重写 AI SDK Core。

---

## 16.2 MCP

MCP 是 Tool 来源之一，不应该成为 Chat 架构本身。

理想关系：

```text
Tool Registry
├── local tools
├── web search
└── MCP tools
```

AI SDK 接到统一 ToolSet 后完成 LLM tool loop。

---

## 16.3 第一版明确不做 Human-in-the-loop Tool

禁止第一阶段加入这种 workflow：

```text
模型请求危险 Tool
↓
暂停
↓
前端弹框
↓
用户 5 分钟后确认
↓
原模型流程继续
```

因为这会要求：

- durable workflow；
- checkpoint；
- pause/resume；
- Worker 内存状态恢复。

这已经进入 LangGraph/Temporal 类问题。

第一阶段所有 LLM Tool 必须能在 Worker 内独立完成。

如果需要用户操作，应另开架构讨论。

---

# 17. RAG / Retrieval Domain

这是硬约束。

## 17.1 上层只知道 Retrieval

示意接口：

```ts
interface Retriever {
  retrieve(input: {
    knowledgeBaseId: string;
    query: string;
    limit?: number;
  }): Promise<RetrievalResult[]>;
}
```

上层绝不能直接写 Pinecone API。

---

## 17.2 Pinecone 只是 Infrastructure Adapter

第一版：

```text
RetrievalService
↓
PineconeVectorStore
```

未来可能：

```text
RetrievalService
↓
PgVectorVectorStore
```

或：

```text
RetrievalService
↓
CustomVectorStore
```

或：

```text
Hybrid Retrieval
BM25 + Vector + Rerank
```

Chat/Generation/Tool 不应该因为迁移而修改。

---

## 17.3 不要把 RAG 等同于 Tool

Retrieval 能力可以被两种方式消费：

### 系统主动检索

```text
User Query
↓
Context Builder
↓
RetrievalService
↓
Relevant Chunks
↓
Model
```

### 模型自主 Tool Search

```text
Model
↓
knowledge_search tool
↓
RetrievalService
↓
Result
↓
Model
```

底层 Retrieval 只有一份。

调用方式可以不同。

---

## 17.4 RAG 内部也要继续分层

未来可能包含：

```text
Parser
Chunker
Embedder
VectorStore
KeywordSearch
Reranker
```

不要把它们硬绑在 Pinecone。

至少预留：

```ts
interface VectorStore {
  upsert(...): Promise<void>;
  search(...): Promise<...>;
  deleteByDocument(...): Promise<void>;
}
```

具体接口以后根据实现再正式设计。

---

# 18. Knowledge Ingestion 是另一种后台任务

不要在 Generation Worker 中临时：

```text
发现 PDF
↓
parse
↓
chunk
↓
embedding
↓
Pinecone upsert
↓
再聊天
```

知识库上传应该：

```text
Upload
↓
Document
↓
Knowledge Ingestion Queue
↓
Parser
↓
Chunker
↓
Embedder
↓
VectorStore
```

Knowledge Base / Document 状态：

```text
processing
ready
failed
```

只有 ready 的知识库参与检索。

既然已有 BullMQ，可以使用独立 Queue，而不是把所有后台任务塞进 Generation Queue。

---

# 19. Attachment / File 边界

V1 中存在：

```text
fileStrategy:
local-parse
moonshot-file-api
none
```

这是 Provider 泄漏。

V2 前端只：

```text
upload file
↓
attachmentId
```

Generation 只接收：

```text
attachmentIds
```

由 Attachment/File service 决定：

- image → vision input；
- text/PDF → extraction；
- KB file → ingestion；
- object storage；
- metadata。

Provider-specific file API 不允许泄漏到前端和 Chat Domain。

---

# 20. Context Builder 与 Summary

Context Builder 独立负责：

> “本次真正给模型哪些上下文？”

它可能组合：

```text
System Prompt
Conversation Summary
Recent Messages
RAG Context
Attachments
Current User Message
```

不要把“数据库全部历史”直接等同于 Model Input。

## Summary 水位线

建议 Summary 有类似：

```ts
{
  content: "...",
  throughSequence: 100
}
```

语义：

> Summary 已完整覆盖到 Message #100。

构建：

```text
Summary(up to #100)
+
Messages sequence > 100
```

避免重复/遗漏。

这也是为什么第一版不支持任意历史消息编辑：编辑 Summary 水位线之前的消息会让 Summary 失效。

---

# 21. LLM Gateway、模型配置与 Token Budget

当前已经确定：

```text
Provider: CatAPI OpenAI-compatible relay
Base URL: https://maomiapi.com/v1
Chat Model: gpt-5.6-sol
```

建议通过服务端环境变量/config 注入，例如：

```text
LLM_PROVIDER=catapi
LLM_BASE_URL=https://maomiapi.com/v1
LLM_API_KEY=...
CHAT_MODEL=gpt-5.6-sol
```

不要把模型 ID、Gateway URL 或 API Key 写死在业务代码中。

2026-08-25 已完成低成本兼容性验证：模型目录、普通 Chat Completions、SSE text delta、AI SDK Core `streamText`、Function Calling、两步 Tool Loop、流式 Tool 参数、Structured Output、图片输入与基础 Responses API 均可调用。

这次验证只证明当前路由的接口行为兼容，不证明中转站上游一定是 OpenAI 官方同名模型，也不证明 reasoning 参数、最大上下文、速率限制、取消后的上游计费、数据保留或服务稳定性与 OpenAI 官方一致。当前密钥只列出文本模型；Embedding Provider 和 Image Model 仍需独立选择。

Reasoning UI 第一阶段只暴露：

```text
low / medium / high
```

由 LLM runtime 映射到 Gateway / Model 的具体参数。

如果未来更换 Gateway 或模型：

- 不修改 ChatMessage；
- 不修改 GenerationEvent；
- 不修改 SSE；
- 不修改 Redis Stream；
- 不修改前端 Projection；
- 只修改 LLM runtime/config/adapter。

同时不要回到 V1：

```text
一个全局 tokenizer
一个全局 CONTEXT_TOKEN_LIMIT
```

即便 V2 产品层只有一个主模型，Context Budget 仍应属于 LLM runtime/config 层。

Context Builder 可以询问：

```text
model context budget
```

而不是依赖全局魔法常量。

如果未来模型替换，Context Builder 的策略接口不需要推翻。

---

# 22. Cancel

用户点击停止：

```http
POST /api/generations/:id/cancel
```

语义：

```text
Generation status → cancelled
↓
Worker 收到 cancellation signal
↓
Abort upstream model request
↓
flush/cleanup
↓
generation.cancelled event
```

跨进程 cancel signal 的具体实现后定，但 API/Domain 必须预留这个概念。

不要把“停止”理解成只在前端 `AbortController` 关闭自己的 fetch，因为 Generation 已经独立于浏览器连接存在。

当前只确定取消控制链路，不提前决定已经生成的 partial Assistant Message 是否持久化。`generation.cancelled` 只表示 Generation 已进入 durable cancelled state，不隐含 partial content 的保存策略；该问题在 Phase 8 实现 Stop 时由开发者结合数据库模型与 UI 明确拍板。

---

# 23. Delete Conversation

如果 Chat 有 Active Generation：

```text
Delete Conversation
↓
cancel active generation
↓
generation terminal state
↓
delete / soft delete conversation
```

Worker 在关键 durable write 前也应确认 Generation 仍允许写。

避免：

```text
Chat 已删
↓
GPT finish
↓
Worker INSERT assistant
↓
foreign key / orphan state
```

---

# 24. 对话分享：不可变快照

V1 的对话分享功能保留到 V2，但与实时 Generation 链路彻底隔离。

```text
Conversation
↓ Share
Immutable Share Snapshot
↓
Public Share Page
```

创建分享时：

1. Conversation 必须没有 Active Generation；
2. 只读取 PostgreSQL 中已经持久化的 Completed Messages；
3. 生成独立、不可变的 Share Snapshot；
4. 公共页面只根据 `shareId/shareToken` 读取该快照并渲染。

Share 不读取 Current Generation Projection，不依赖 BullMQ、Redis Stream 或 SSE。分享生成后，原 Conversation 继续聊天、重新生成、删除消息，甚至删除整个 Conversation，都不应改变已有快照。

因此 Share Snapshot 应是独立的 durable entity，不能设计成会随 Conversation 级联删除的临时字段。第一版不做“实时同步分享内容”；用户需要新版本时应重新创建一个快照。

---

# 25. 多 Tab

架构天然支持多个消费者订阅同一个 Generation：

```text
Tab A ─┐
       ├─ GET same SSE / Redis event log
Tab B ─┘
```

每个 consumer 有自己的 cursor。

但是两个 Tab 同时发送消息仍然必须依靠服务端“一 Chat 一个 Active Generation”约束防止并发。

---

# 26. 第一阶段运行假设与失败边界

第一阶段默认 PostgreSQL、Redis、BullMQ、Worker 与上游模型服务正常可用。当前目标是把正常主链路跑通并保证代码执行顺序正确，不建设生产级故障恢复系统。

## 正常服务可用时支持的恢复

浏览器：

- 网络短断；
- EventSource 重连；
- 页面暂时断线；
- 多 Tab；
- active generation event replay。

因为 Redis 保存 Application Event Log。

## 第一阶段不承诺的事情

Worker 真正崩溃后，无法让上游模型从丢失的下一个 token 精确继续，也不保证跨数据库、队列和 Redis 的状态自动修复。恢复服务后由用户显式重新生成即可。

基础设施故障恢复只有未来明确进入需求范围时才重新讨论，当前代码不为它预留复杂框架。

不要在简历或面试中把“浏览器断线后从 Redis replay”描述成“任何服务器或数据库故障都能自动恢复”。前者是当前真实能力，后者不是当前范围。

---

# 27. Reasoning

前端可以提供：

```text
low / medium / high
```

这是业务输入。

但是不要假设：

```text
reasoning effort
=
模型一定向客户端暴露完整 reasoning stream
```

`reasoning.delta` 应是 optional event。

如果模型只提供 reasoning summary / metadata，也不要为了统一 UI 伪造完整思考链。

---

# 28. Chat 与 Image 必须是真正独立 Pipeline

不要只是：

```text
/chat 页面
/image 页面
```

最后仍然进：

```ts
generate(mode)
```

然后：

```ts
if (mode === "image")
```

满天飞。

应该：

```text
Chat Domain
    ChatGenerationService
    Chat Worker path

Image Domain
    ImageGenerationService
    Image Worker path
```

共享基础设施，但不共享业务管线。

Conversation mode 创建后 immutable。

---

# 29. Auth 与 EventSource

原生 EventSource 不擅长自定义 Authorization Header。

因此 Web App 推荐：

> 同源 HttpOnly Cookie / Session

这样：

```ts
new EventSource("/api/...")
```

可以自然携带同源 Cookie。

**这目前属于推荐部署/鉴权策略，不是必须立刻写死数据库 Auth 方案。**

如果未来必须跨域 Bearer Header，需重新评估 EventSource transport。

---

# 30. 推荐工程结构：正式 Workspace，控制分包数量

Web 和 Worker 有不同运行生命周期，使用同仓库的 pnpm workspace 表达 runtime 边界是合理的，不是微服务化。共享的领域类型、协议和基础设施代码放在少量 package 中，避免复制。

建议起点：

```text
apps/
├── web/                       # Next.js UI、Command API、SSE API
└── worker/                    # 独立 Node.js BullMQ Worker

packages/
├── core/                      # Conversation、Message、Generation、协议与应用用例
├── db/                        # PostgreSQL schema、migration、query
├── llm/                       # LLM runtime 与 AI SDK Adapter
└── shared/                    # 少量跨 runtime 配置/工具，禁止变成垃圾桶
```

做到对应功能时，再根据真实依赖增加：

```text
packages/retrieval/
packages/tools/
packages/share/
```

不在初始化时创建未来功能的空 package，也不把每个领域对象拆成独立 npm package。`apps/web` 与 `apps/worker` 是两个可独立启动、测试和部署的 runtime，但仍属于一个项目、一个语言栈和一套代码审查流程。

包内可以清楚区分 domain、application、infrastructure，但按实际代码规模组织；不要机械要求每个用例都有 controller/service/repository/interface 四件套。架构质量由依赖方向和职责决定，不由目录数量决定。

---

# 31. 架构宪法：Codex 必须优先遵守

以下是当前 V2 的 Hard Constraints（当前 35 条）。Codex 可以提出修改建议，但只有开发者明确拍板后才能修改；确认修改时必须同步更新本节与相关正文，不能保留已经被推翻的旧约束。

1. **开发者最新明确拍板的架构决策优先于本文档，本文档优先于当前代码；代码冲突默认视为实现偏差，不得用已落地或测试通过为理由反向修改架构。**
2. **旧仓库 V1 只读参考，不直接大改。V2 新建项目。**
3. **Conversation 创建时选择 `chat` / `image`，mode 不可修改。**
4. **产品层不支持 Chat Model 动态切换。Provider 是服务端实现细节。**
5. **同一个 Chat 同时最多一个 Active Generation。**
6. **不支持任意历史 User Message 编辑/Conversation Branch。**
7. **Regenerate 创建新 Generation，但采用单回答替换语义：新回答成功提交时才删除旧 Assistant Message；失败或取消时保留旧回答。**
8. **PostgreSQL 是 Completed Message 唯一永久 Source of Truth。**
9. **不可变 Share Snapshot 是独立 durable entity，只包含 terminal 状态下的 Completed Messages，不依赖实时 Generation 链路。**
10. **Redis Stream 是短生命周期 Generation Event Log，不是永久数据库。**
11. **首次实时消费和恢复都走同一个 GenerationEvent + GET SSE + EventSource 链路。**
12. **Redis Stream ID 默认直接映射 SSE event ID / resume cursor；只有开发者确认存在明确理由后才能增加映射层。**
13. **SSE Handler 只做 Transport，不做 LLM/RAG/Tool/coalescing。**
14. **AI SDK Core 只存在于 LLM Execution 边界。**
15. **禁止 AI SDK UI types/protocol 越过防腐层。**
16. **CatAPI 等 Gateway/relay 只属于 LLM Infrastructure；Provider、Base URL 与 Model 路由细节不得泄漏到业务层。**
17. **AI SDK Adapter 只映射少量非终态语义事件；finish/error 作为内部执行结果交给 Worker，不直接产生公开 terminal event。**
18. **Generation 由 BullMQ Worker 执行，不依附 POST 请求生命周期。**
19. **第一阶段只保证 PostgreSQL、BullMQ、Redis 正常可用时的状态顺序，不引入 Outbox、分布式事务、跨存储补偿或自动故障恢复。**
20. **模型生成开始后第一版不做隐式自动 retry。失败由用户显式重新生成。**
21. **`generation.completed` / `failed` / `cancelled` 只能在对应 PostgreSQL durable state 成立后由 Worker 发出。**
22. **服务端在 Redis 前做 lossless Delta Coalescing。**
23. **前端用 rAF 进行 render scheduling，不让网络频率直接驱动 React。**
24. **所有第一阶段 LLM Tools 必须可由 Worker 独立完成。**
25. **第一阶段不做 Human-in-the-loop / browser-executed tool workflow。**
26. **RAG 上层只依赖 Retrieval abstraction，Pinecone 不允许泄漏。**
27. **Knowledge ingestion 与 chat generation 是不同后台任务。**
28. **Attachment/File 领域不包含 provider-specific file strategy。**
29. **Summary 需要明确 coverage watermark / `throughSequence`。**
30. **Context Budget 属于模型 runtime/config，不做全局固定假设。**
31. **Worker 崩溃后的 provider token stream 不承诺 token-level resume，也不承诺第一阶段自动修复跨系统状态。**
32. **不允许因为“实现更方便”偷偷改回 `fetch + UIMessageStream + useChat`。**
33. **不为尚未进入范围的生产故障假设提前堆叠中间件或可靠性机制。**
34. **控制复杂度不等于降低正常架构质量或把 V2 做成 Demo；V2 必须在保留核心能力的同时，拥有比 V1 更清晰、可测试、可解释的边界。**
35. **如果 Codex 认为某条 Hard Constraint 已经阻碍真实需求，必须先解释并讨论；开发者明确拍板后才能修改约束与本文档，不得自行绕过，也不得继续执行已被正式推翻的约束。**

---

# 32. 当前明确不做的事情

为了避免再次组合爆炸：

- 用户动态多 Chat Model 切换；
- Chat ↔ Image 中途切 Mode；
- 历史消息任意编辑后分支；
- Conversation Tree；
- 多版本 Assistant Answer、`selected` / `superseded` 回答管理；
- Human-in-the-loop Tool pause/resume；
- Browser Tool 作为第一阶段核心能力；
- 自己重写完整 Tool Calling engine；
- 自己重写 BullMQ；
- 自己复制 AI SDK UI stream；
- Redis event 永久保留；
- Worker 崩溃后 token 精确断点续生成；
- 第一版 Snapshot + Event 双恢复机制；
- 为 PostgreSQL、BullMQ、Redis 的故障情况增加 Outbox、分布式事务、自动补偿、后台对账或复杂 retry；
- 第一版为“工业级”强行引 Kafka/Temporal/Kubernetes。

---

# 33. 可以后续演进但不能污染当前边界

这些产品能力未来可以做：

- Pinecone → pgvector → 自研 VectorStore；
- Vector Search → Hybrid Retrieval；
- Reranker；
- Knowledge Search Tool；
- 更高级 Context Strategy；
- Image Pipeline；
- provider migration。

实际部署验证属于当前演进路线：项目完成核心功能后，应把 Web、Worker、PostgreSQL 与 Redis 作为独立进程实际运行一次，以验证 runtime 分离不是只在本地开发命令中成立。具体部署拓扑在对应阶段讨论，不提前锁定。

扩容、高可用和基础设施故障恢复不列入当前演进路线。只有未来出现真实需求时再单独设计，当前不提前预留框架。

关键要求：

> 这些演进应该通过替换接口实现或新增独立模块完成，而不是迫使 Chat 主链推倒重写。

---

# 34. 推荐开发顺序：必须小 Commit

不要一次让 Codex 写完整系统。

按架构层逐步实现，但每个 Phase 结束都必须有测试或可运行验证，不能只留下空目录和类型声明。

### Phase 1：Workspace、领域与协议

1. 初始化 `apps/web`、`apps/worker` 和最少共享 packages；
2. 定义 Conversation、Message 与 immutable mode；
3. 定义 Generation lifecycle 与一个 Chat 一个 Active Generation；
4. 定义文字主链需要的少而稳定的 GenerationEvent Protocol；Tool/Source 事件到 Phase 6 再扩展实现；
5. 为领域约束和 reducer 写单元测试。

### Phase 2：持久化与后台任务

1. 建立 PostgreSQL schema 和 migration；
2. 实现 Conversation、Message、Generation 的 query/mutation；
3. 在数据库层约束一个 Chat 最多一个 Active Generation；
4. 接入 BullMQ，并让独立 Worker 能领取 generationId；
5. 验证 Web 与 Worker 共享领域代码但拥有独立生命周期。

### Phase 3：Generation Event Log 与 SSE

1. 实现 Redis GenerationEventStore；
2. Worker 写入明确的测试事件序列；
3. SSE Handler 读取并编码事件；
4. 支持 Redis Stream ID / SSE ID / `Last-Event-ID`；
5. 加入 heartbeat 和事件存储测试。

这里使用测试事件是为了验证正式协议与 runtime 边界，不是产品降级模式；验证完成后仍由真实 LLM Runtime 驱动同一条链路。

### Phase 4：前端状态与渲染

1. 实现历史消息读取与游标分页；
2. 实现 EventSource client；
3. 实现 Generation Projection reducer；
4. 收到 completed 后刷新 PostgreSQL Messages 并移除 Projection；
5. 验证首次消费、断线重连和页面刷新使用同一事件协议。

### Phase 5：真实 LLM Runtime

1. 定义 LLM runtime 边界；
2. 通过 AI SDK Core + `@ai-sdk/openai-compatible` + CatAPI 接入 `gpt-5.6-sol`；
3. Adapter 只映射 `text.delta` 和模型实际提供时的 `reasoning.delta`；
4. finish/error 作为内部执行结果返回 Worker，由 Worker 完成 durable terminal state 和公开 terminal event；
5. 为 Adapter 写 contract tests；
6. 加入 Delta Coalescer 和前端 rAF scheduling，并做可观测的性能对比；
7. 加入一条完整主链 Integration Test：使用 Fake LLM 依次输出“你”和“好”，走真实 PostgreSQL、BullMQ、Redis 与 SSE 路径，验证 POST 入队、Worker 消费、Redis 事件写入、cursor 严格向后 replay、同一批事件驱动 Projection、PostgreSQL 最终保存“你好”，并验证 `generation.completed` 只在 durable state 成立后出现。

完成这一阶段后，必须得到一条功能完整、可断线恢复、可持久化的正式文字聊天主链路，而不是 Demo 假流。

### Phase 6：Tool 与 MCP

1. 建立 Tool Registry；
2. 先验证一个本地 Tool 的 multi-step loop；
3. 接入 Web Search；
4. 接入 MCP Tools；
5. 此时再映射并展示 `tool.called`、`tool.completed`、`source.added` 等必要事件。

### Phase 7：RAG 与 Knowledge Ingestion

1. 定义 Retrieval、Embedder、VectorStore 的真实最小边界；
2. 实现 Pinecone Adapter；
3. 接入 Context Builder；
4. 建立独立 Knowledge Ingestion Queue；
5. 完成上传、解析、切块、Embedding、索引、状态与删除闭环。

### Phase 8：高级 Chat

逐项实现 reasoning effort、Stop、成功后替换式 Regenerate、Summary 水位线和删除会话协调，每项单独验证。

### Phase 9：Share

实现独立不可变 Share Snapshot、创建接口和公共只读页面。

### Phase 10：Image

独立规划并实现 Image Pipeline，不在 Chat Pipeline 中顺手塞分支。

### Phase 11：实际部署与架构验证

1. 结合届时的代码和成本约束确定部署拓扑；
2. 使用 Docker Compose/VPS 或同等方式，让 Web、Worker、PostgreSQL 与 Redis 以独立进程运行；
3. 执行核心聊天主链、断线 replay、后台任务和持久化 smoke test；
4. 记录部署边界和启动方式，但不追加高可用、自动扩容、跨存储补偿或基础设施故障自愈。

---

# 35. Codex 的工作方式要求

这是项目成功的重要部分。

每次实施时：

1. **先阅读本文件中相关章节。**
2. **再阅读 V1 对应功能，理解旧行为和旧问题。**
3. **不要机械迁移旧代码。**
4. **每次只实现一个清晰的架构层/功能。**
5. **尽量小 Commit。**
6. **新增依赖前说明它解决什么问题，以及为什么不自己实现。**
7. **Route Handler 保持简短，但不要因此给每个操作机械创建 controller/service/repository 等五层文件；优先提取一个可测试的普通业务函数。**
8. **不要为了“抽象”提前创造无真实用途的接口、基类、依赖注入容器或泛型框架。**
9. **关键协议和 Adapter 要有测试。**
10. **遇到架构冲突先停下来说明，不要偷偷兼容。**
11. **每次代码落地后更新实现进度和验证事实；新讨论只有在开发者明确拍板后，才能修改本文档中的架构决策或 Hard Constraints，并删除已过时结论。**
12. **新对话或上下文压缩后先读本文档，再检查当前代码；如果二者冲突，默认按实现偏差处理，不得让代码自动覆盖架构。**
13. **当前需求没有要求的故障恢复和生产强化，不要因为“架构完整”擅自加入。**
14. **任何以“简化”为名删除 V1 核心能力或压平 Web/Worker、协议、领域和外部依赖边界的建议，都必须先说明会损失什么，不能直接执行。**

开发者会在每次 commit 后重新阅读 diff、理解代码并做架构 review，因此代码要方便学习与审计，而不是一次自动生成几千行。

---

# 36. 未来面试时这套架构真正值得讲什么

这不是让 Codex 为“简历关键词”堆技术，而是说明为什么当前设计有价值。

可以深入讲：

- 多模型能力矩阵为何造成组合爆炸；
- 为什么主动砍掉动态多模型；
- 为什么 Conversation Mode immutable；
- 为什么自己定义 Application Protocol；
- 为什么只使用 AI SDK Core；
- Anti-Corruption Layer 如何隔离外部 SDK；
- 为什么 `POST Command + GET Subscription`；
- 为什么使用原生 EventSource；
- SSE `id` / `Last-Event-ID`；
- Redis Streams replay；
- 为什么 Redis Stream ID 直接作为 cursor；
- 实时消费和恢复消费为什么统一；
- BullMQ 为什么解决 HTTP/Generation 生命周期不一致；
- 为什么第一阶段只做最小重复执行保护，而不引入 Outbox 和分布式事务；
- 为什么 `completed` 必须代表 durable commit；
- 为什么服务端 coalescing 与客户端 rAF batching 都需要；
- PostgreSQL / Queue / Redis Stream 三种存储职责；
- Context Builder；
- Summary watermark；
- RAG abstraction；
- Pinecone 可替换性；
- Knowledge ingestion queue；
- Tool Calling multi-step；
- Regenerate 为什么等待新回答成功后再替换旧回答；
- 不可变分享快照为什么与实时 Generation 链路隔离；
- failure domain：客户端断线恢复 ≠ provider token stream 恢复。

这些都是从真实问题演化出来的，不应退化成“为了面试硬堆中间件”。

---

# 37. 当前仍是 Open Question 的地方

以下内容 Codex 不应自行拍板：

1. 新仓库最终名字；
2. Image Model；
3. ORM/DB layer 具体技术；
4. Message content/parts 最终 schema；
5. Redis Stream TTL；
6. DeltaCoalescer flush interval / max size；
7. BullMQ concurrency；
8. cancel signal 的跨进程实现；
9. auth 最终方案；
10. object storage；
11. RAG embedding provider；
12. Chunk Strategy；
13. Pinecone index schema；
14. 是否存 Tool execution 的完整 input/output；
15. reasoning 展示形态；
16. production deployment topology；
17. Cancelled Generation 是否持久化已经生成的 partial Assistant Message。

以下内容已经确定，不再属于 Open Question：

```text
Chat Model: GPT-5.6 Sol
Provider: CatAPI OpenAI-compatible relay
Base URL: https://maomiapi.com/v1
Provider model ID: gpt-5.6-sol
LLM integration: AI SDK Core behind our own runtime/adapter boundary

Regenerate:
创建新 Generation；运行时可在 UI 隐藏旧回答；失败/取消保留旧回答；
新回答成功时在 PostgreSQL transaction 中删除旧 Assistant、写入新 Assistant。

Cross-system consistency:
第一阶段只保证 PostgreSQL、BullMQ、Redis 正常可用时的执行顺序；
不做 Outbox、分布式事务、跨存储补偿、自动 reconciliation 或复杂 retry。

AI SDK terminal semantics:
finish/error 是 LLM execution 的内部结果；
公开 generation.completed/failed/cancelled 由 Worker 在 PostgreSQL 状态写入成功后发出。

Conversation sharing:
保留 V1 的不可变分享快照；只从 Completed Messages 创建；
仅允许在没有 Active Generation 时分享；分享页不依赖 Redis、BullMQ、SSE 或 Current Generation Projection。
```

这些仍未确定的事项，应在真正做到对应阶段时，根据需求和当前代码讨论。

---

# 38. 最终主链路

如果实现过程中迷路，回到这张图。

```text
User
│
│ send
▼
POST /chats/:chatId/generations
│
├─ persist User Message
├─ create Generation(queued)
└─ enqueue BullMQ
       │
       ▼
Generation Worker
│
├─ load durable context
├─ Context Builder
│    ├─ Summary
│    ├─ Recent Messages
│    ├─ RetrievalService
│    └─ Attachments
│
├─ Tool Registry
│    ├─ local
│    ├─ web
│    └─ MCP
│
└─ LLM Runtime
     │
     └─ AI SDK Core
          │
          ▼
       fullStream
          │
          ▼
 AI SDK Anti-Corruption Adapter
          │
          ├─ streaming semantic events
          │        │
          │        ▼
          │   DeltaCoalescer
          │        │
          │        ▼
          │   Redis Streams
          │        │
          │        │ GET /generations/:id/events
          │        ▼
          │       SSE
          │        │
          │        ▼
          │   EventSource
          │        │
          │        ▼
          │   Generation Projection
          │        │
          │        ▼
          │   rAF Render Scheduler
          │        │
          │        ▼
          │      React
          │
          └─ finish → internal LlmRunResult → Worker

LLM execution finish:
Worker
↓
flush deltas
↓
PostgreSQL transaction
  普通生成：insert assistant message
  重新生成：delete old assistant + insert new assistant
  update generation = completed
↓
COMMIT
↓
generation.completed event
↓
Frontend refetches durable messages
↓
Projection removed

LLM execution error/cancel:
Adapter throws/returns abort
↓
Worker writes generation failed/cancelled to PostgreSQL
↓
Worker emits matching terminal event
```

---

# 39. 最后的判断标准

V2 不是要证明“所有轮子都能自己造”。

V2 也不是为了少写代码而做的 Demo。它必须重新覆盖 V1 中真正有价值的功能，并用更清晰的领域、协议、runtime 和依赖边界实现。

正确目标是：

> **把真正属于这个系统、值得掌控和解释的复杂度留在自己手里；把已经被成熟基础设施很好解决、自己重写只会增加风险的复杂度交给库。**

我们自己掌控：

- Domain；
- Protocol；
- Generation Lifecycle；
- Event Log；
- Resume；
- SSE；
- State Projection；
- Render Scheduling；
- Context Management；
- Retrieval Abstraction；
- 正常路径的状态顺序；
- 清晰且不夸大的第一阶段失败边界。

我们复用成熟基础设施：

- AI SDK Core → Provider / Tool Calling / Multi-step；
- BullMQ → Job Queue / Worker；
- Redis → Queue backend + Event Stream storage；
- PostgreSQL → Durable business state；
- Pinecone（当前）→ Vector storage/search implementation。

如果后续代码又逐渐变成：

```text
AI SDK type 到处都是
Pinecone query 到处都是
Provider if 到处都是
Route Handler 300 行+
正常流一套、恢复流一套
history + live + snapshot 多 Source merge
```

说明 V2 正在重新走回 V1，必须立即停止。

反过来，如果后续为了“简单”而删除 Worker、Redis Event Log、自有协议、关键测试或 V1 的核心功能，只留下普通的请求转发聊天页面，也说明 V2 已经退化成玩具项目，必须停止并重新评估。

---

**本文件是 V2 持续维护的架构 Source of Truth。实际实现或最新讨论改变决策后，必须同步重写本文档，不能让 Codex 在未来继续执行已经过时的设计。**
