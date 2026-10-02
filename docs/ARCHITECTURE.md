# 当前架构导读

本文是当前实现的阅读地图，不替代[架构约束](../AI_CHAT_V2_ARCHITECTURE_BRIEF.md)。项目采用 pnpm workspace，部署形态是单机上的 Web、Worker、PostgreSQL、Redis 和 Caddy，文件放在私有 R2。

## 先看一条聊天请求

```text
浏览器 ── 创建 Generation ──→ Web API ── 事务 ──→ PostgreSQL
                                  └── 入队 ──→ BullMQ ──→ Worker
浏览器 ←── SSE ───────────── Web ←── Redis Streams ←── Worker
                                                        ├── 模型 / 工具
                                                        └── 定稿 ──→ PostgreSQL
```

1. Web 根据登录身份校验请求，在事务中保存用户消息、Generation 及本轮工具选择。外部模型调用不占用这个事务。
2. 事务提交后，Web 用 `generationId` 作为 BullMQ Job ID 入队。Worker 领取任务，读取历史、装配工具、检查上下文预算。
3. Worker 调用模型，合并相邻文本增量，把统一的 GenerationEvent 写入 Redis Streams；Web 按游标读取并通过 SSE 转发。
4. 浏览器按帧批量更新流式投影。完成、失败或停止时刷新数据库历史，成功对账后由历史消息接管展示。
5. Worker 把已有输出和 Generation 终态在同一数据库事务中定稿。完全没有输出时，不人为创建空助手消息。

浏览器断开 SSE 不等于取消任务；“停止生成”是独立命令。数据库与入队也不是跨系统原子事务：入队失败返回明确错误，已保存的 queued 任务可通过相同命令重新尝试入队；没有 Outbox 或后台自动补偿。参见 [create.ts](../apps/web/src/server/generations/create.ts)、[command.ts](../packages/db/src/generations/command.ts)。

## 三种状态，不是三个相同的缓存

| 层 | 保存什么 | 生命周期与职责 |
| --- | --- | --- |
| PostgreSQL | Conversation、Message、Generation、文件元数据、知识库、摘要 | 持久事实；刷新页面后重新读取 |
| Redis | BullMQ 任务及独立的 GenerationEvent Stream | 队列负责调度；Stream 负责实时回放，最后追加后保留 24 小时 |
| 浏览器 | Query 历史页、Zustand 流式投影、组件局部交互状态 | Query 管服务端数据；Zustand 管未被历史接管的输出和游标；局部状态管弹窗、草稿等交互 |

Generation 是一次执行，Message 是留下来的内容。重新生成可以针对同一用户消息创建新的执行，因此不能把执行状态等同于消息正文。会话行锁串行化相关写操作，数据库部分唯一索引约束同会话最多一个 queued/running Generation。

## 流式续传与渲染优化

- Worker 的 [delta-coalescer.ts](../apps/worker/src/generation/delta-coalescer.ts) 首个有效增量直接输出；之后合并同类型、同 part 的相邻增量，默认延迟阈值 40 ms、字符阈值 128。遇到工具事件、结束或错误先刷新已有增量，不跨事件边界拼接。这些是合并策略，不是严格实时调度保证。
- 浏览器的 [generation-event-buffer.ts](../apps/web/src/components/chat/generation/generation-event-buffer.ts) 用 `requestAnimationFrame` 收集一帧中的事件，再一次提交状态；终态立即刷新队列。减少状态提交不等于同等比例减少 React Commit，后者需要 Profiler 实测。
- [projection store](../apps/web/src/components/chat/generation/generation-projection-store.ts) 同时保存内容和已应用的 `lastEventId`，按 Redis ID 去重。不能先推进游标再应用内容，否则离开页面时可能跳过未显示的增量。
- 切走关闭连接但保留投影；回来先读取最新详情，同一活跃任务才从缓存游标续传。原生重连使用 `Last-Event-ID`；整页刷新丢失内存投影，运行中任务从事件起点回放，而不是重新调用模型。
- 投影最多保留最近访问的 5 个会话，淘汰内容与游标，不停止服务端任务。不是持久化到 localStorage，也不是按字节限制内存。
- [虚拟列表](../apps/web/src/components/chat/messages/virtual-message-list.tsx) 处理动态高度、向上加载和底部跟随。历史分页减少读取量，虚拟化减少挂载量，批量更新减少更新频率，三者解决的问题不同。

续传范围仅限仍可读取的事件日志；这不是 Redis 丢失后也能恢复任意中间状态的高可用承诺。

## 工具与知识库

知识库文件走“Web 签名 → 浏览器 PUT R2 → Web 核验完成 → Worker 解析、切块、向量化 → 事务发布 ready”，不是把大文件先传给 Web 再转发。

[工具解析器](../apps/worker/src/tools/generation-tool-resolver.ts) 根据本轮快照统一装配联网搜索、MCP 和知识库搜索。业务当前只有 Agentic 路径：模型决定何时调用 `search_knowledge`，而非每次问答先固定检索并注入上下文。

一次知识库检索内部仍是确定的流水线：带账户/知识库过滤的向量与 BM25 候选 → RRF 合并 → Rerank → 资料片段。授权范围绑定在服务端闭包，模型只提供 query。每轮至多三次知识库调用，每次六条；来源按 chunk 去重并稳定编号，以快照保存，刷新后不依赖重新检索。

完整工具参数和结果只在服务端保存；浏览器收到去敏后的过程状态和引用资料。引用存在并不证明每句话受到证据支持。相关实现：[knowledge-search-tool.ts](../apps/worker/src/tools/knowledge-search-tool.ts)、[assistant-output.ts](../apps/worker/src/generation/assistant-output.ts)。

## 长历史不是直接截断

[共享历史投影](../packages/model-context/src/history.ts) 同时供计数与模型请求使用。消息保存时预计算文本/协议 token，附件根据实际内容生成派生计数缓存。旧知识库原文与调用结果不重复回放；可见思考作为有标注的普通历史文本保留，不伪装为模型原生推理状态。

[上下文准备](../apps/worker/src/context/prepare-chat-context.ts) 在预算触发时摘要较早的完整轮次，保留近期原文和当前问题。原始消息不删除，摘要只是派生数据。当前 200k 触发、60k 总输入目标、8k 摘要软目标是工程配置，不是通用最优比例；重试与安全预算细节见 [README](../README.md)。

## 按这个顺序读源码

1. [contracts](../packages/contracts/README.md)：先认识 Message Parts、Generation 与事件契约。
2. [Web 创建命令](../apps/web/src/server/generations/create.ts) → [数据库事务](../packages/db/src/generations/command.ts)：身份、幂等、锁和入队边界。
3. [聊天执行](../apps/worker/src/generation/execute-chat-generation.ts) → [输出消费](../apps/worker/src/generation/assistant-output.ts)：生命周期与输出持久化。
4. [事件存储](../packages/event-store/README.md) → [SSE 消费](../apps/web/src/components/chat/generation/use-generation-event-stream.ts) → [投影](../apps/web/src/components/chat/generation/generation-projection-store.ts)：回放、去重与页面切换。
5. [历史缓存](../apps/web/src/components/chat/messages/conversation-history-query.ts) → [虚拟列表](../apps/web/src/components/chat/messages/virtual-message-list.tsx)：终态接管与长列表交互。
6. 最后读工具、知识库、摘要及 [CI/CD](../deploy/CI_CD.md)，避免同时追太多分支。

## 明确保留的边界

这是个人学习项目：发布会短暂停机；数据库和 Redis 之间没有分布式事务；对象删除是尽力清理，没有自动补偿；进程硬退出后的所有任务状态不保证自动修复。外部模型可超时，文档可能包含恶意指令，模型也可能引用错误。测试覆盖已定义的行为，不等于消除了所有线上故障。
