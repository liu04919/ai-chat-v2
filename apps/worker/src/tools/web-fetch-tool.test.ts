import { describe, expect, it, vi } from "vitest";

import { createDeepSeekWebFetchTool, MAX_WEB_CONTENT_CHARACTERS, webFetchInputSchema } from "./web-fetch-tool";

const execution = { toolCallId: "fetch-1", messages: [], context: {} };

describe("DeepSeek web fetch tool", () => {
  it("调用固定官方端点，返回请求 URL 和 Markdown 正文，忽略额外字段", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ title: " 文档 ", content: "# 正文\n内容", privateMetadata: "not exposed" }));
    const page = createDeepSeekWebFetchTool({ apiKey: "test", fetch: request });
    await expect(page.execute!({ url: "https://example.com/article" }, execution)).resolves.toEqual({
      url: "https://example.com/article", title: "文档", content: "# 正文\n内容", truncated: false,
    });
    expect(request.mock.calls[0]?.[0]).toBe("https://api.deepseek.com/v1/tools/fetch");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({ url: "https://example.com/article" });
    expect(request.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("长正文截断但不让工具失败，不截断代理对，并明确标记", async () => {
    const page = createDeepSeekWebFetchTool({ apiKey: "test", fetch: async () => Response.json({ title: "", content: "🐉".repeat(MAX_WEB_CONTENT_CHARACTERS + 1) }) });
    await expect(page.execute!({ url: "https://example.com/" }, execution)).resolves.toEqual({
      url: "https://example.com/", title: "https://example.com/", content: "🐉".repeat(MAX_WEB_CONTENT_CHARACTERS), truncated: true,
    });
  });

  it.each(["not a URL", "file:///etc/passwd", "javascript:alert(1)", "ftp://example.com/a", "https://user:password@example.com/", "https://user@example.com/", `https://example.com/${"a".repeat(8192)}`])("拒绝非法或携带凭据的 URL：%s", (url) => {
    expect(webFetchInputSchema.safeParse({ url }).success).toBe(false);
  });

  it.each(["https://example.com/a?x=1", "http://example.com/"])("接受公开网页地址格式：%s", (url) => {
    expect(webFetchInputSchema.parse({ url })).toEqual({ url });
  });

  it("不能读取的页面作为工具错误，不伪造正文或泄露上游响应", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("upstream secret", { status: 404 }));
    const page = createDeepSeekWebFetchTool({ apiKey: "test", fetch: request });
    await expect(page.execute!({ url: "https://example.com/" }, execution)).rejects.toThrow("DeepSeek fetch 失败（HTTP 404）");
    expect(request).toHaveBeenCalledOnce();
  });
});
