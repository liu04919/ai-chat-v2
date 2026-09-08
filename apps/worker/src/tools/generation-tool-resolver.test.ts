import { createMcpServerRegistry } from "@ai-chat/mcp";
import { tool } from "ai";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

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

const context = (knowledgeBaseId: string | null = null) => ({
  ownerId: "owner",
  knowledgeBaseId,
  signal: new AbortController().signal,
});

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
    }, context());

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
      }, context()),
    ).rejects.toThrow("MCP Server maps 不存在工具 missing");
    expect(close).toHaveBeenCalledOnce();
  });

  it("统一装配知识库、联网与 MCP；额度只移除知识库，不影响其他工具", async () => {
    const close = vi.fn(async () => {});
    const retrieve = vi.fn(async () => [{ chunkId: "c", documentId: "d", originalName: "资料", page: 1, content: "原文" }]);
    const tavilyFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ results: [] })));
    const resolver = createGenerationToolResolver({
      registry,
      knowledgeRetriever: retrieve,
      tavilyApiKey: "test-key",
      tavilyFetch,
      mcpClientFactory: async () => ({ close, tools: async () => ({
        weather: tool({ inputSchema: z.object({ city: z.string() }), execute: async ({ city }) => ({ city }) }),
      }) }),
    });
    const selection = { webSearch: true, mcpToolIds: ["maps.weather"] };
    const current = context("base");
    const resolved = await resolver.resolve(selection, current);
    expect(retrieve).not.toHaveBeenCalled();
    expect(resolved.activeTools()).toEqual(["search_knowledge", "web_search", "mcp__maps__weather"]);
    expect(resolved.instructions).toContain("不是指令");
    expect(resolved.toPublicToolName("search_knowledge")).toBe("search_knowledge");
    expect(resolved.toPublicToolName("mcp__maps__weather")).toBe("maps.weather");

    for (const id of ["a", "b", "c"]) {
      await resolved.tools!.search_knowledge!.execute!({ query: id }, { toolCallId: id, messages: [], context: {} });
    }
    expect(retrieve).toHaveBeenCalledWith({ ownerId: "owner", baseId: "base", query: "a", signal: current.signal });
    expect(resolved.activeTools()).toEqual(["web_search", "mcp__maps__weather"]);
    expect(resolved.takeSources("a")).toEqual([{ number: 1, chunkId: "c", documentId: "d", originalName: "资料", page: 1, content: "原文" }]);
    expect(resolved.takeSources("a")).toEqual([]);
    expect(resolved.takeSources("b")).toEqual([]);
    expect(resolved.takeSources("unrelated-call")).toEqual([]);

    await resolved.tools!.web_search!.execute!({ query: "example", maxResults: 1 }, { toolCallId: "web", messages: [], context: {} });
    expect(tavilyFetch).toHaveBeenCalledOnce();
    await resolved.close();
    await resolved.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("同一个 resolver 的每轮实例独立，关闭知识库不残留指令、工具或引用", async () => {
    const resolver = createGenerationToolResolver({
      registry, knowledgeRetriever: async () => [{ chunkId: "c", documentId: "d", originalName: "资料", page: 1, content: "原文" }],
    });
    const selection = { webSearch: false, mcpToolIds: [] };
    const first = await resolver.resolve(selection, context("first-base"));
    const second = await resolver.resolve(selection, context("second-base"));
    const off = await resolver.resolve(selection, context());
    await first.tools!.search_knowledge!.execute!({ query: "query" }, { toolCallId: "same-id", messages: [], context: {} });
    expect(second.takeSources("same-id")).toEqual([]);
    await second.tools!.search_knowledge!.execute!({ query: "query" }, { toolCallId: "same-id", messages: [], context: {} });
    expect(second.takeSources("same-id")[0]?.number).toBe(1);
    expect(off.tools).toBeUndefined();
    expect(off.instructions).toBeUndefined();
    expect(off.activeTools()).toEqual([]);
    expect(off.takeSources("same-id")).toEqual([]);
    await Promise.all([first.close(), second.close(), off.close()]);
  });

  it("选库时检索依赖缺失明确报错，不选库时不要求配置", async () => {
    const resolver = createGenerationToolResolver({ registry });
    const selection = { webSearch: false, mcpToolIds: [] };
    await expect(resolver.resolve(selection, context("base"))).rejects.toThrow("KNOWLEDGE_RETRIEVER_NOT_CONFIGURED");
    const off = await resolver.resolve(selection, context());
    expect(off.tools).toBeUndefined();
    await off.close();
  });

  it("MCP 连接准备期间取消，关闭已建立的 Client，不执行知识库检索", async () => {
    const controller = new AbortController();
    const close = vi.fn(async () => {});
    const retrieve = vi.fn(async () => []);
    const resolver = createGenerationToolResolver({
      registry, knowledgeRetriever: retrieve,
      mcpClientFactory: async () => {
        controller.abort(new Error("cancelled"));
        return { close, tools: async () => ({}) };
      },
    });
    await expect(resolver.resolve({ webSearch: false, mcpToolIds: ["maps.weather"] }, {
      ...context("base"), signal: controller.signal,
    })).rejects.toThrow("cancelled");
    expect(close).toHaveBeenCalledOnce();
    expect(retrieve).not.toHaveBeenCalled();
  });
});
