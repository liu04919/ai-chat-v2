import { describe, expect, it, vi } from "vitest";

import { createDeepSeekWebSearchTool, webSearchInputSchema } from "./web-search-tool";

describe("DeepSeek web search tool", () => {
  it("只请求搜索摘要并映射已有来源格式，不把原始正文返回给模型", async () => {
    let capturedInit: RequestInit | undefined;
    const request = vi.fn(async (...args: Parameters<typeof fetch>) => {
      capturedInit = args[1];
      return Response.json({
        results: [
          {
            title: "Redis documentation",
            url: "https://redis.io/docs/latest/",
            summary: "Redis latest documentation snippet",
            snippet: "短摘要",
            date: "2026-08-30T00:00:00Z",
            content: "不应进入 Tool Result",
          },
        ],
      });
    });
    const search = createDeepSeekWebSearchTool({
      apiKey: "test-deepseek-key",
      fetch: request,
    });

    if (!search.execute) {
      throw new Error("DeepSeek Tool 缺少 execute");
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
          publishedAt: "2026-08-30T00:00:00Z",
        },
      ],
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe("https://api.deepseek.com/v1/tools/search");
    expect(capturedInit?.headers).toEqual({
      Authorization: "Bearer test-deepseek-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      query: "Redis latest",
      count: 3,
      need_content: false,
    });
  });

  it("不把上游响应正文和密钥暴露在错误中", async () => {
    const search = createDeepSeekWebSearchTool({
      apiKey: "secret-key",
      fetch: async () => new Response("sensitive upstream body", { status: 401 }),
    });

    await expect(
      search.execute?.(
        { query: "rate limit", maxResults: 5 },
        { toolCallId: "call-2", messages: [], context: {} },
      ),
    ).rejects.toThrow("DeepSeek search 失败（HTTP 401）");
  });

  it("长摘要为空时使用短摘要，日期缺失时不编造，结果数不超过请求上限", async () => {
    const search = createDeepSeekWebSearchTool({ apiKey: "test", fetch: async () => Response.json({
      results: Array.from({ length: 3 }, () => ({ title: " ", url: "https://example.com/", summary: null, snippet: " 摘要 ", date: null })),
    }) });
    await expect(search.execute!({ query: "示例", maxResults: 1 }, { toolCallId: "s", messages: [], context: {} })).resolves.toEqual({
      query: "示例", results: [{ title: "https://example.com/", url: "https://example.com/", snippet: "摘要" }],
    });
  });

  it("正常空结果与缺少结果字段的异常响应分开处理", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ results: [] }))
      .mockResolvedValueOnce(Response.json({ error: "private upstream error" }));
    const search = createDeepSeekWebSearchTool({ apiKey: "test", fetch: request });
    const execute = () => search.execute!({ query: "示例", maxResults: 5 }, { toolCallId: "s", messages: [], context: {} });
    await expect(execute()).resolves.toEqual({ query: "示例", results: [] });
    await expect(execute()).rejects.toThrow("DeepSeek search 响应格式无效");
  });

  it("搜索词按 Unicode 字符而非 UTF-16 长度限制，保留最多八条的产品上限", () => {
    expect(webSearchInputSchema.parse({ query: " 🐉 " })).toEqual({ query: "🐉", maxResults: 5 });
    expect(webSearchInputSchema.safeParse({ query: "🐉".repeat(128) }).success).toBe(true);
    expect(webSearchInputSchema.safeParse({ query: "🐉".repeat(129) }).success).toBe(false);
    expect(webSearchInputSchema.safeParse({ query: " " }).success).toBe(false);
    expect(webSearchInputSchema.safeParse({ query: "test", maxResults: 9 }).success).toBe(false);
  });
});
