import { tool } from "ai";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { createMcpServerRegistry } from "../mcp";
import { createGenerationToolResolver } from "./generation-tool-resolver";

const registry = createMcpServerRegistry([
  {
    id: "maps",
    title: "地图",
    description: "地图工具",
    source: "third-party",
    connection: { transport: "http", url: "https://mcp.example.com/" },
  },
]);

describe("Generation tool resolver", () => {
  it("仅注入本轮选择的 MCP tools，并在流结束后关闭 Client", async () => {
    const close = vi.fn(async () => {});
    const resolver = createGenerationToolResolver({
      registry,
      mcpClientFactory: async () => ({
        close,
        tools: async () => ({
          weather: tool({
            description: "查询天气",
            inputSchema: z.object({ city: z.string() }),
            execute: async ({ city }) => ({ city }),
          }),
          route: tool({
            description: "规划路线",
            inputSchema: z.object({ from: z.string(), to: z.string() }),
            execute: async (input) => input,
          }),
        }),
      }),
    });

    const resolved = await resolver.resolve({
      webSearch: false,
      mcpToolIds: ["maps.weather"],
    });

    expect(Object.keys(resolved.tools ?? {})).toEqual([
      "mcp__maps__weather",
    ]);
    expect(resolved.toPublicToolName("mcp__maps__weather")).toBe(
      "maps.weather",
    );
    expect(close).not.toHaveBeenCalled();
    await resolved.close();
    await resolved.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("选择不存在的工具时关闭已经创建的 Client", async () => {
    const close = vi.fn(async () => {});
    const resolver = createGenerationToolResolver({
      registry,
      mcpClientFactory: async () => ({
        close,
        tools: async () => ({}),
      }),
    });

    await expect(
      resolver.resolve({
        webSearch: false,
        mcpToolIds: ["maps.missing"],
      }),
    ).rejects.toThrow("MCP Server maps 不存在工具 missing");
    expect(close).toHaveBeenCalledOnce();
  });
});
