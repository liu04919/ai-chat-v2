# @ai-chat/contracts

这个 package 是 Browser、Web/API 与 Worker 之间可序列化协议的唯一入口。

每份 contract 以 Zod Schema 为运行时事实来源，再由 Schema 推导 TypeScript 类型。领域实体、数据库 row、AI SDK stream part、React state 和 Redis/SSE framing 不属于这里。

当前只放已经有架构决定支撑的最小契约：

- Conversation mode、列表、按角色约束的有序 Message Parts 与详情响应
- Attachment 上传意图、上传确认、草稿移除与错误响应
- Generation 创建命令、初始响应、错误与 Worker job
- GenerationEvent 与 Redis Stream cursor
- Generation status 与 reasoning effort
- Chat Detail 的 active Generation

修改 contract 时，需要在同一轮更新 Schema、推导类型、fixtures、tests 和消费者。

会话详情默认返回最新 30 条消息，页内按 `sequence` 升序；响应中的 `nextCursor` 用作下一次请求的 `before` 参数（严格小于该序号），为 `null` 时结束。此游标是 Message sequence，与 Redis/SSE 的 GenerationEvent cursor 无关。模型上下文读取不使用这个展示分页合同。
