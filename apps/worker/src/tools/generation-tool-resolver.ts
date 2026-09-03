import type { GenerationToolSelectionDto } from "@ai-chat/contracts";
import {
  createRemoteMcpClient,
  type McpServerRegistry,
} from "@ai-chat/mcp";
import type { ToolSet } from "ai";

import {
  createMcpToolId,
  parseMcpToolId,
  toMcpRuntimeToolName,
} from "./tool-names";
import { createTavilyWebSearchTool } from "./web-search-tool";

export type ResolvedGenerationTools = {
  tools: ToolSet | undefined;
  toPublicToolName(runtimeName: string): string;
  close(): Promise<void>;
};

export type GenerationToolResolver = {
  resolve(
    selection: GenerationToolSelectionDto,
  ): Promise<ResolvedGenerationTools>;
};

type RuntimeMcpClient = {
  tools(): Promise<ToolSet>;
  close(): Promise<void>;
};

export function createGenerationToolResolver(options: {
  registry: McpServerRegistry;
  tavilyApiKey?: string;
  tavilyFetch?: typeof fetch;
  mcpClientFactory?: (
    server: ReturnType<McpServerRegistry["get"]>,
  ) => Promise<RuntimeMcpClient>;
}): GenerationToolResolver {
  const mcpClientFactory = options.mcpClientFactory ?? createRemoteMcpClient;

  return {
    async resolve(selection) {
      const tools: ToolSet = {};
      const publicNames = new Map<string, string>();
      const clients: RuntimeMcpClient[] = [];
      let closed = false;

      async function close(): Promise<void> {
        if (closed) {
          return;
        }
        closed = true;
        const results = await Promise.allSettled(
          clients.map((client) => client.close()),
        );
        for (const result of results) {
          if (result.status === "rejected") {
            console.error("关闭 MCP Client 失败", result.reason);
          }
        }
      }

      try {
        if (selection.webSearch) {
          if (!options.tavilyApiKey?.trim()) {
            throw new Error("联网搜索已启用，但 Worker 未配置 TAVILY_API_KEY");
          }

          tools.web_search = createTavilyWebSearchTool({
            apiKey: options.tavilyApiKey,
            ...(options.tavilyFetch ? { fetch: options.tavilyFetch } : {}),
          });
          publicNames.set("web_search", "web_search");
        }

        const selectionsByServer = new Map<string, string[]>();
        for (const toolId of selection.mcpToolIds) {
          const { serverId, toolName } = parseMcpToolId(toolId);
          const selected = selectionsByServer.get(serverId) ?? [];
          selected.push(toolName);
          selectionsByServer.set(serverId, selected);
        }

        for (const [serverId, selectedToolNames] of selectionsByServer) {
          const client = await mcpClientFactory(options.registry.get(serverId));
          clients.push(client);
          const serverTools = await client.tools();

          for (const toolName of selectedToolNames) {
            const selectedTool = serverTools[toolName];
            if (!selectedTool) {
              throw new Error(`MCP Server ${serverId} 不存在工具 ${toolName}`);
            }

            const runtimeName = toMcpRuntimeToolName(serverId, toolName);
            const publicName = createMcpToolId(serverId, toolName);
            if (tools[runtimeName]) {
              throw new Error(`MCP Tool 运行时名称冲突: ${runtimeName}`);
            }

            tools[runtimeName] = selectedTool;
            publicNames.set(runtimeName, publicName);
          }
        }

        return {
          tools: Object.keys(tools).length > 0 ? tools : undefined,
          toPublicToolName(runtimeName) {
            return publicNames.get(runtimeName) ?? runtimeName;
          },
          close,
        };
      } catch (error) {
        await close();
        throw error;
      }
    },
  };
}
