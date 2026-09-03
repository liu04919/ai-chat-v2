# @ai-chat/mcp

服务端专用的远程 MCP 边界，供 Web 做工具发现、供 Worker 做实际执行。

- Registry 保存 Server 来源和连接配置，对外摘要不含 URL、Header 或 AK。
- Catalog 使用 MCP `tools/list` 读取完整分页，并做五分钟进程内缓存。
- Client 使用远程 Streamable HTTP，不启动 stdio 子进程。
- 浏览器不得直接导入本包；Web 只能通过鉴权 API 返回精简目录。
