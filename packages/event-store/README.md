# @ai-chat/event-store

这个 package 保存 Web 与 Worker 共享的 GenerationEvent 日志边界。

Redis Stream 只承担短期实时事件日志：Worker 追加事件，Web/SSE 按 cursor 读取和重放。Redis Stream ID 直接作为公开 cursor；事件 payload 必须通过 `@ai-chat/contracts` 的运行时 Schema。

Stream 在最后一次追加事件后保留 24 小时。PostgreSQL 仍然是 Generation 状态和 Message 的永久事实来源。
