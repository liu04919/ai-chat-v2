import { MCP_TOOL_ID_SEPARATOR } from "@ai-chat/contracts";

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

export function toRuntimeHistoryToolName(toolName: string): string {
  if (!toolName.includes(MCP_TOOL_ID_SEPARATOR)) {
    return toolName;
  }

  const parsed = parseMcpToolId(toolName);
  return toMcpRuntimeToolName(parsed.serverId, parsed.toolName);
}
