import { createMcpServerRegistry, type McpToolCatalog } from "@ai-chat/mcp";
import { describe, expect, it, vi } from "vitest";

import { listMcpTools } from "./mcp-tools";

const registry = createMcpServerRegistry([
  {
    id: "fortune",
    title: "传统文化与塔罗",
    description: "Fortune tools",
    source: "owned",
    connection: {
      transport: "http",
      url: "https://fortune.example.com/mcp",
      headers: { Authorization: "Bearer fortune-secret" },
    },
  },
  {
    id: "maps",
    title: "地图",
    description: "Map tools",
    source: "third-party",
    connection: {
      transport: "http",
      url: "https://maps.example.com/mcp?ak=maps-secret",
    },
  },
]);

describe("MCP Tool catalog server", () => {
  it("按 Server 隔离发现失败，并且响应不包含连接密钥和 Schema", async () => {
    const catalog: McpToolCatalog = {
      discoverServerTools: vi.fn(async (serverId) => {
        if (serverId === "maps") {
          throw new Error("maps offline with maps-secret");
        }

        return {
          server: registry.get(serverId),
          tools: [
            {
              id: "fortune.draw_tarot_reading",
              serverId: "fortune",
              name: "draw_tarot_reading",
              title: "塔罗抽牌",
              description: "抽取塔罗牌",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        };
      }),
      clear: vi.fn(),
    };
    const onDiscoveryError = vi.fn();

    const response = await listMcpTools(
      { registry, catalog },
      onDiscoveryError,
    );

    expect(response.servers).toEqual([
      expect.objectContaining({
        id: "fortune",
        status: "available",
        tools: [
          expect.objectContaining({ id: "fortune.draw_tarot_reading" }),
        ],
      }),
      expect.objectContaining({
        id: "maps",
        status: "unavailable",
        tools: [],
      }),
    ]);
    expect(JSON.stringify(response)).not.toContain("secret");
    expect(JSON.stringify(response)).not.toContain("inputSchema");
    expect(onDiscoveryError).toHaveBeenCalledOnce();
  });
});
