import {
  createMCPClient,
  type ListToolsResult,
  type MCPClient,
} from "@ai-sdk/mcp";

import type {
  McpServerRegistry,
  McpServerSummary,
  RemoteMcpServerDefinition,
} from "./mcp-server-registry";

export const MCP_TOOL_DISCOVERY_TTL_MS = 5 * 60 * 1000;
export const MCP_REQUEST_TIMEOUT_MS = 10 * 1000;

type McpTool = ListToolsResult["tools"][number];

export type DiscoveredMcpTool = {
  id: string;
  serverId: string;
  name: string;
  title?: string;
  description?: string;
  inputSchema: McpTool["inputSchema"];
  outputSchema?: McpTool["outputSchema"];
  annotations?: McpTool["annotations"];
};

export type McpServerToolCatalog = {
  server: McpServerSummary;
  tools: readonly DiscoveredMcpTool[];
};

type DiscoveryMcpClient = Pick<MCPClient, "listTools" | "close">;

export type McpClientFactory = (
  server: RemoteMcpServerDefinition,
) => Promise<DiscoveryMcpClient>;

export type McpToolCatalog = {
  discoverServerTools(
    serverId: string,
    options?: { forceRefresh?: boolean },
  ): Promise<McpServerToolCatalog>;
  clear(serverId?: string): void;
};

type CacheEntry = {
  expiresAt: number;
  catalog: McpServerToolCatalog;
};

function toCatalogTool(serverId: string, tool: McpTool): DiscoveredMcpTool {
  return {
    id: `${serverId}.${tool.name}`,
    serverId,
    name: tool.name,
    inputSchema: tool.inputSchema,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}

async function listEveryTool(client: DiscoveryMcpClient): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const page = await client.listTools({
      ...(cursor ? { params: { cursor } } : {}),
      options: { timeout: MCP_REQUEST_TIMEOUT_MS },
    });
    tools.push(...page.tools);

    const nextCursor = page.nextCursor;
    if (!nextCursor) {
      break;
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error("MCP Server 返回了重复的 tools/list 游标");
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (true);

  return tools;
}

export async function createRemoteMcpClient(
  server: RemoteMcpServerDefinition,
): Promise<MCPClient> {
  return createMCPClient({
    transport: {
      type: "http",
      url: server.connection.url,
      ...(server.connection.headers
        ? { headers: { ...server.connection.headers } }
        : {}),
    },
    clientName: "ai-chat-worker",
    version: "0.1.0",
    initializationOptions: { timeout: MCP_REQUEST_TIMEOUT_MS },
    maxRetries: 0,
  });
}

export function createMcpToolCatalog(options: {
  registry: McpServerRegistry;
  clientFactory?: McpClientFactory;
  cacheTtlMs?: number;
  now?: () => number;
}): McpToolCatalog {
  const clientFactory = options.clientFactory ?? createRemoteMcpClient;
  const cacheTtlMs = options.cacheTtlMs ?? MCP_TOOL_DISCOVERY_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<McpServerToolCatalog>>();

  async function load(serverId: string): Promise<McpServerToolCatalog> {
    const server = options.registry.get(serverId);
    const client = await clientFactory(server);

    try {
      const tools = await listEveryTool(client);
      const ids = new Set<string>();
      const catalogTools = tools.map((tool) => {
        const catalogTool = toCatalogTool(serverId, tool);
        if (ids.has(catalogTool.id)) {
          throw new Error(`MCP Server ${serverId} 返回了重复工具 ${tool.name}`);
        }
        ids.add(catalogTool.id);
        return catalogTool;
      });
      const serverSummary = options.registry
        .list()
        .find((candidate) => candidate.id === serverId);

      if (!serverSummary) {
        throw new Error(`未知的 MCP Server: ${serverId}`);
      }

      return { server: serverSummary, tools: catalogTools };
    } finally {
      await client.close();
    }
  }

  return {
    discoverServerTools(serverId, discoveryOptions) {
      const cached = cache.get(serverId);
      if (
        !discoveryOptions?.forceRefresh &&
        cached &&
        cached.expiresAt > now()
      ) {
        return Promise.resolve(cached.catalog);
      }

      const pending = inFlight.get(serverId);
      if (pending) {
        return pending;
      }

      const discovery = load(serverId)
        .then((catalog) => {
          cache.set(serverId, {
            catalog,
            expiresAt: now() + cacheTtlMs,
          });
          return catalog;
        })
        .finally(() => {
          inFlight.delete(serverId);
        });
      inFlight.set(serverId, discovery);
      return discovery;
    },
    clear(serverId) {
      if (serverId) {
        cache.delete(serverId);
      } else {
        cache.clear();
      }
    },
  };
}
