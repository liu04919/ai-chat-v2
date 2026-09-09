import { describe, expect, it, vi } from "vitest";
import { createHistorySummarizer } from "./history-summarizer";

function sse(text: string, incomplete = false) {
  const events = [
    {
      type: "response.created",
      response: { id: "r", created_at: 1, model: "gpt-5.6-sol" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "m", phase: "final_answer" },
    },
    {
      type: "response.output_text.delta",
      item_id: "m",
      output_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "m", phase: "final_answer" },
    },
    {
      type: incomplete ? "response.incomplete" : "response.completed",
      response: {
        incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
        usage: { input_tokens: 30, output_tokens: 20 },
        reasoning: null,
      },
    },
  ];
  return (
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
    "data: [DONE]\n\n"
  );
}
const input = () => ({
  previousSummary: "之前确认的约束",
  history: ["用户：继续开发"],
  targetTokens: 8000,
  signal: new AbortController().signal,
});

describe("Sol 历史摘要适配器（模拟 Responses SSE，不访问网络）", () => {
  it("沿用 Responses 流式渠道、不注册工具，8k 目标与输出预算独立", async () => {
    let request: Request | undefined;
    const summarize = createHistorySummarizer({
      baseUrl: "https://example.test/v1",
      apiKey: "test",
      modelId: "gpt-5.6-sol",
      fetch: async (url, init) => {
        request = new Request(url, init);
        return new Response(sse("已确认：继续开发，保留原始消息。"), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    expect(await summarize.summarize(input())).toContain("保留原始消息");
    expect(request?.url).toBe("https://example.test/v1/responses");
    const body = (await request!.json()) as {
      tools?: unknown[];
      input: unknown;
    };
    expect(body).toMatchObject({
      model: "gpt-5.6-sol",
      stream: true,
      store: false,
      max_output_tokens: 16000,
    });
    expect(body.tools ?? []).toEqual([]);
    expect(JSON.stringify(body.input)).toContain("之前确认的约束");
    expect(JSON.stringify(body)).toContain("不得把推测变成事实");
  });

  it.each(["incomplete", "empty", "error"])(
    "拒绝 %s 响应而不是保存不完整摘要",
    async (failure) => {
      const fetch = vi.fn(
        async () =>
          new Response(
            failure === "error"
              ? `data: ${JSON.stringify({ type: "error", code: "upstream", message: "failed" })}\n\n`
              : sse(
                  failure === "empty" ? "" : "partial",
                  failure === "incomplete",
                ),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      const summarize = createHistorySummarizer({
        baseUrl: "https://example.test/v1",
        apiKey: "test",
        modelId: "gpt-5.6-sol",
        fetch,
      });
      await expect(
        summarize.summarize({ ...input(), targetTokens: 10 }),
      ).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(failure === "error" ? 1 : 2);
    },
  );

  it("已取消时连摘要请求都不会发出", async () => {
    const fetch = vi.fn();
    const summarize = createHistorySummarizer({
      baseUrl: "https://example.test/v1",
      apiKey: "test",
      modelId: "gpt-5.6-sol",
      fetch,
    });
    await expect(
      summarize.summarize({
        ...input(),
        signal: AbortSignal.abort(new Error("stopped")),
      }),
    ).rejects.toThrow("stopped");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([503, 401])("HTTP %s 只对临时错误重试一次", async (status) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: "unavailable", type: "api_error" },
          }),
          { status, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(sse("完整摘要"), {
          headers: { "content-type": "text/event-stream" },
        }),
      );
    const summarizer = createHistorySummarizer({
      baseUrl: "https://example.test/v1",
      apiKey: "test",
      modelId: "gpt-5.6-sol",
      fetch,
    });
    if (status === 503)
      await expect(summarizer.summarize(input())).resolves.toBe("完整摘要");
    else await expect(summarizer.summarize(input())).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(status === 503 ? 2 : 1);
  });

  it.each(["shortened", "failed", "still-long"])(
    "摘要偏长时精简一次：%s",
    async (outcome) => {
      const draft = "long summary ".repeat(100).trim();
      const requests: Request[] = [];
      const fetch = vi.fn(
        async (url: string | URL | Request, init?: RequestInit) => {
          requests.push(new Request(url, init));
          if (requests.length === 2 && outcome === "failed")
            return new Response("unavailable", { status: 503 });
          const text =
            requests.length === 1
              ? draft
              : outcome === "shortened"
                ? "简短完整摘要"
                : draft + " longer";
          return new Response(sse(text), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      );
      const summarizer = createHistorySummarizer({
        baseUrl: "https://example.test/v1",
        apiKey: "test",
        modelId: "gpt-5.6-sol",
        fetch,
      });
      expect(await summarizer.summarize({ ...input(), targetTokens: 10 })).toBe(
        outcome === "shortened" ? "简短完整摘要" : draft,
      );
      expect(fetch).toHaveBeenCalledTimes(2);
      const retry = JSON.stringify(await requests[1]!.json());
      expect(retry).toContain("draft");
      expect(retry).not.toContain("用户：继续开发");
    },
  );

  it("略超软目标不重试，用户取消不因已有草稿而继续", async () => {
    const text = "hello world";
    const controller = new AbortController();
    const fetch = vi.fn(
      async () =>
        new Response(sse(text), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const summarizer = createHistorySummarizer({
      baseUrl: "https://example.test/v1",
      apiKey: "test",
      modelId: "gpt-5.6-sol",
      fetch,
    });
    expect(await summarizer.summarize({ ...input(), targetTokens: 1 })).toBe(
      text,
    );
    expect(fetch).toHaveBeenCalledOnce();
    fetch.mockImplementationOnce(async () => {
      controller.abort(new Error("user stopped"));
      return new Response(sse(text), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    await expect(
      summarizer.summarize({ ...input(), signal: controller.signal }),
    ).rejects.toThrow("user stopped");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
