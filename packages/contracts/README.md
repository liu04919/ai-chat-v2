# @ai-chat/contracts

这个 package 是 Browser、Web/API 与 Worker 之间可序列化协议的唯一入口。

每份 contract 以 Zod Schema 为运行时事实来源，再由 Schema 推导 TypeScript 类型。领域实体、数据库 row、AI SDK stream part、React state 和 Redis/SSE framing 不属于这里。

当前只放已经有架构决定支撑的最小契约：

- Conversation mode、列表与详情响应
- Attachment 上传意图、上传确认与错误响应
- Generation status
- Chat Detail 的 active Generation

修改 contract 时，需要在同一轮更新 Schema、推导类型、fixtures、tests 和消费者。
