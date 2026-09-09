# @ai-chat/contracts

这个 package 是 Browser、Web/API 与 Worker 之间可序列化协议的唯一入口。

跨边界的 JSON 协议以 Zod Schema 为运行时事实来源，再由 Schema 推导 TypeScript 类型。数据库 row、AI SDK stream part、React state 和 Redis/SSE framing 不属于这里；共享常量和 `KnowledgeChunk` 片段类型也不代表额外的公开接口。

## 阅读入口

- `conversation.ts`：会话模式、列表、详情、消息分页和删除响应；详情包含 active/latest Generation。
- `conversation-share.ts`：公开分享状态、Token、不可变消息与附件快照、停止分享响应和错误码。
- `message.ts`：按角色区分的 Message Parts；服务端完整工具记录与浏览器展示投影分开定义。
- `attachment.ts`：附件上传意图、预签名指令、完成确认、读取、删除与错误响应。
- `generation-command.ts`、`generation-regeneration.ts`、`generation-cancellation.ts`：发送、重新生成和取消的请求/响应、错误，以及生成任务 Job。
- `generation.ts`：生成状态、推理档位和 active Generation；不保存前端运行态。
- `generation-tools.ts`：联网/MCP 选择、工具目录和用户偏好。
- `generation-event.ts`：文本、思考、工具展示状态、知识库引用和生成终态事件，以及 Redis Stream cursor。
- `knowledge.ts`：知识库与文档、直传上传、入库 Job、删除响应、HTTP 错误和引用快照。

消费者从 `@ai-chat/contracts` 导入，不在前后端各复制一份同名类型。`.parse()` / `.safeParse()` 负责运行时校验，TypeScript 类型不能替代对网络数据的检查。

## 关键边界

会话详情默认返回最新 30 条消息，页内按 `sequence` 升序；响应中的 `nextCursor` 用作下一次请求的 `before` 参数（严格小于该序号），为 `null` 时结束。此游标是 Message sequence，与 Redis/SSE 的 GenerationEvent cursor 无关。模型上下文读取不使用这个展示分页合同。

知识库上传只发送文件元信息，文件本体按预签名指令直传对象存储；完成接口直接返回 `knowledgeDocumentSchema`，不是 `{ document }` 包装。删除文档返回 `{ documentId }`；删除知识库返回 `{ baseId, cleanupFailed }`，保留数据库删除后原文件清理失败的警告。HTTP 错误统一为 `knowledgeErrorResponseSchema` 的 `{ code }`，不携带内部异常。HTTP 状态和用户提示仍分别由服务端、客户端映射。

完整 Tool input/output 只在服务端存储和重建模型上下文；会话响应及 `tool.call` / `tool.result` 事件只公开展示字段。`knowledge.sources` 与消息内的 `knowledge-sources` 共用引用结构，上限均为 18 条，空列表合法；引用只包含编号、来源位置和原文，不包括向量、内部评分或对象 key。

## 示例与验证

`examples/http/knowledge/` 覆盖创建知识库、列表、上传、完成、删除、选库发送和错误响应。`examples/worker/knowledge.job.json` 展示入库任务，`examples/redis/generation-event/knowledge-sources.json` 展示引用事件。其他现有 HTTP、Worker 与流事件示例保留在各自目录；这些是协议示例，不包含真实密钥，也不会发起付费模型请求。

`fixtures.test.ts` 校验示例 JSON 与 Schema 一致；各协议测试检查合法值、非法输入与隐私边界。接口和客户端消费协议的测试位于 Web 对应模块。

```bash
pnpm exec vitest run packages/contracts/src
```

修改 contract 时，需要在同一轮更新 Schema、推导类型、fixtures、tests 和消费者。增加字段不会自动完成鉴权，归属检查仍由服务端负责。
