import { describe, expect, it, vi } from "vitest";

import { createTavilyWebSearchTool } from "./web-search-tool";

describe("Tavily web search tool", () => {
  it("使用受限的 basic 搜索并只返回模型需要的来源字段", async () => {
    let capturedInit: RequestInit | undefined;
    const request = vi.fn(async (...args: Parameters<typeof fetch>) => {
      capturedInit = args[1];
      return Response.json({
        results: [
          {
            title: "Redis documentation",
            url: "https://redis.io/docs/latest/",
            content: "Redis latest documentation snippet",
            published_date: "2026-08-30",
            raw_content: "不应进入 Tool Result",
          },
        ],
      });
    });
    const search = createTavilyWebSearchTool({
      apiKey: "test-tavily-key",
      fetch: request,
    });

    if (!search.execute) {
      throw new Error("Tavily Tool 缺少 execute");
    }

    const output = await search.execute(
      { query: "Redis latest", maxResults: 3 },
      { toolCallId: "call-1", messages: [], context: {} },
    );

    expect(output).toEqual({
      query: "Redis latest",
      results: [
        {
          title: "Redis documentation",
          url: "https://redis.io/docs/latest/",
          snippet: "Redis latest documentation snippet",
          publishedAt: "2026-08-30",
        },
      ],
    });
    expect(request).toHaveBeenCalledOnce();
    expect(capturedInit?.headers).toEqual({
      Authorization: "Bearer test-tavily-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      query: "Redis latest",
      topic: "general",
      search_depth: "basic",
      max_results: 3,
      include_answer: false,
      include_images: false,
      include_raw_content: false,
      auto_parameters: false,
    });
  });

  it("不把上游响应正文和密钥暴露在错误中", async () => {
    const search = createTavilyWebSearchTool({
      apiKey: "secret-key",
      fetch: async () => new Response("sensitive upstream body", { status: 429 }),
    });

    await expect(
      search.execute?.(
        { query: "rate limit", maxResults: 5 },
        { toolCallId: "call-2", messages: [], context: {} },
      ),
    ).rejects.toThrow("Tavily 搜索失败（HTTP 429）");
  });
});
