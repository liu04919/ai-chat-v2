import { MCP_TOOL_ID_SEPARATOR } from "@ai-chat/contracts";

// 纯命名规则通过独立子路径导出，不加载 MCP Client，供工具装配和历史回放共用。
const MCP_RUNTIME_PREFIX = "mcp__";

function sanitizeRuntimeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function parseMcpToolId(toolId: string): {
  serverId: string;
  toolName: string;
} {
  const separatorIndex = toolId.indexOf(MCP_TOOL_ID_SEPARATOR);

  if (separatorIndex <= 0 || separatorIndex >= toolId.length - 1) {
    throw new Error(`无效的 MCP Tool ID: ${toolId}`);
  }

  return {
    serverId: toolId.slice(0, separatorIndex),
    toolName: toolId.slice(separatorIndex + MCP_TOOL_ID_SEPARATOR.length),
  };
}

export function createMcpToolId(serverId: string, toolName: string): string {
  return `${serverId}${MCP_TOOL_ID_SEPARATOR}${toolName}`;
}

export function toMcpRuntimeToolName(
  serverId: string,
  toolName: string,
): string {
  return `${MCP_RUNTIME_PREFIX}${sanitizeRuntimeSegment(serverId)}__${sanitizeRuntimeSegment(toolName)}`;
}
