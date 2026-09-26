import { MCP_TOOL_ID_SEPARATOR } from "@ai-chat/contracts";
import {
  parseMcpToolId,
  toMcpRuntimeToolName,
} from "@ai-chat/mcp/tool-names";

export const KNOWLEDGE_SEARCH_TOOL_NAME = "search_knowledge";

// 历史中只转换 MCP 的公开 ID；联网搜索、知识库等本地工具保持原名。
export function toRuntimeHistoryToolName(toolName: string): string {
  if (!toolName.includes(MCP_TOOL_ID_SEPARATOR)) {
    return toolName;
  }

  const parsed = parseMcpToolId(toolName);
  return toMcpRuntimeToolName(parsed.serverId, parsed.toolName);
}
