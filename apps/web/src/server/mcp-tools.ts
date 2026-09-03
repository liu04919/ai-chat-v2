import {
  mcpToolCatalogResponseSchema,
  type McpToolCatalogResponse,
} from "@ai-chat/contracts";
import {
  createConfiguredMcpServerRegistry,
  createMcpToolCatalog,
  type McpServerRegistry,
  type McpToolCatalog,
} from "@ai-chat/mcp";

type McpToolCatalogServices = {
  registry: McpServerRegistry;
  catalog: McpToolCatalog;
};

let configuredServices: McpToolCatalogServices | undefined;

function getConfiguredServices(): McpToolCatalogServices {
  if (configuredServices) {
    return configuredServices;
  }

  const fortuneUrl = process.env.FORTUNE_MCP_URL;
  const fortuneApiKey = process.env.FORTUNE_MCP_API_KEY;
  const baiduMapsApiKey = process.env.BAIDU_MAPS_API_KEY;
  const registry = createConfiguredMcpServerRegistry({
    ...(fortuneUrl ? { FORTUNE_MCP_URL: fortuneUrl } : {}),
    ...(fortuneApiKey ? { FORTUNE_MCP_API_KEY: fortuneApiKey } : {}),
    ...(baiduMapsApiKey ? { BAIDU_MAPS_API_KEY: baiduMapsApiKey } : {}),
  });
  configuredServices = {
    registry,
    catalog: createMcpToolCatalog({ registry }),
  };
  return configuredServices;
}

export async function listMcpTools(
  services: McpToolCatalogServices = getConfiguredServices(),
  onDiscoveryError: (serverId: string, error: unknown) => void = (
    serverId,
    error,
  ) => console.error(`发现 MCP Server ${serverId} 工具失败`, error),
): Promise<McpToolCatalogResponse> {
  const servers = await Promise.all(
    services.registry.list().map(async (server) => {
      try {
        const discovered = await services.catalog.discoverServerTools(
          server.id,
        );

        return {
          ...server,
          status: "available" as const,
          tools: discovered.tools.map((tool) => ({
            id: tool.id,
            name: tool.name,
            ...(tool.title ? { title: tool.title } : {}),
            ...(tool.description ? { description: tool.description } : {}),
          })),
        };
      } catch (error) {
        onDiscoveryError(server.id, error);
        return {
          ...server,
          status: "unavailable" as const,
          tools: [],
          message: "暂时无法读取工具列表",
        };
      }
    }),
  );

  return mcpToolCatalogResponseSchema.parse({ servers });
}
