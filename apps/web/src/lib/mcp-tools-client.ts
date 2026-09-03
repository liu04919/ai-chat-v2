import {
  mcpToolCatalogResponseSchema,
  type McpToolCatalogResponse,
} from "@ai-chat/contracts";

export const mcpToolCatalogQueryKey = ["mcp-tool-catalog"] as const;

export async function fetchMcpToolCatalog(
  signal?: AbortSignal,
): Promise<McpToolCatalogResponse> {
  const response = await fetch("/api/tools/mcp", {
    signal,
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("无法加载 MCP 工具");
  }

  return mcpToolCatalogResponseSchema.parse(await response.json());
}
