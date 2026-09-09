import {
  mcpToolPreferencesSchema,
  type McpToolPreferencesDto,
} from "@ai-chat/contracts";

export async function updateMcpToolPreferences(
  preferences: McpToolPreferencesDto,
): Promise<McpToolPreferencesDto> {
  const response = await fetch("/api/tools/mcp/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(preferences),
  });

  if (!response.ok) {
    throw new Error("无法保存 MCP 工具配置");
  }

  return mcpToolPreferencesSchema.parse(await response.json());
}
