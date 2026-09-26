# @ai-chat/mcp

服务端专用的远程 MCP 边界，供 Web 做工具发现、供 Worker 做实际执行。

- Registry 保存 Server 来源和连接配置，对外摘要不含 URL、Header 或 AK。
- Catalog 使用 MCP `tools/list` 读取完整分页，并做五分钟进程内缓存。
- Client 使用远程 Streamable HTTP，不启动 stdio 子进程。
- `@ai-chat/mcp/tool-names` 是独立的纯函数入口，负责 MCP 工具 ID 创建、解析和运行时命名，不加载 Client。工具目录、Worker 装配和 `model-context` 历史回放共用这些规则；历史转换和知识库工具名仍归 `model-context`。
- 浏览器不得直接导入本包；Web 只能通过鉴权 API 返回精简目录。
