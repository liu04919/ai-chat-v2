import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createDeepSeekWebClient } from "./deepseek-web-client";

const schema = z.object({ ok: z.boolean() });
afterEach(() => vi.restoreAllMocks());

describe("DeepSeek web client", () => {
  it("空凭据不发请求", () => {
    expect(() => createDeepSeekWebClient({ apiKey: " " })).toThrow("DEEPSEEK_API_KEY 不能为空");
  });

  it.each([408, 429, 500, 504])("HTTP %s 最多重试一次", async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("upstream private body", { status }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const request = createDeepSeekWebClient({ apiKey: "test", fetch });
    await expect(request("search", { query: "test" }, schema)).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(fetch.mock.calls[1]?.[1]?.signal);
  });

  it("两次都失败后停止，不暴露原始正文", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("secret-key", { status: 503 }));
    await expect(createDeepSeekWebClient({ apiKey: "secret-key", fetch })("fetch", {}, schema)).rejects.toThrow("DeepSeek fetch 失败（HTTP 503）");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 402, 403, 404])("HTTP %s 不做无效重试", async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("private upstream body", { status }));
    await expect(createDeepSeekWebClient({ apiKey: "test", fetch })("fetch", {}, schema)).rejects.toThrow(`HTTP ${status}`);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("屏蔽底层异常及 JSON 校验错误", async () => {
    const request = createDeepSeekWebClient({ apiKey: "secret-key", fetch: async () => { throw new Error("secret-key in request"); } });
    await expect(request("search", {}, schema)).rejects.toThrow("DeepSeek search 请求失败，请稍后再试");
    const invalid = createDeepSeekWebClient({ apiKey: "test", fetch: async () => Response.json({ ok: "secret-key" }) });
    await expect(invalid("search", {}, schema)).rejects.toThrow("DeepSeek search 响应格式无效");
  });

  it("已取消的 Generation 不会发送请求", async () => {
    const signal = AbortSignal.abort(new Error("用户停止"));
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(createDeepSeekWebClient({ apiKey: "test", fetch, signal })("fetch", {}, schema)).rejects.toThrow("用户停止");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("等待重试期间取消，不再发送第二次请求", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      setTimeout(() => controller.abort(new Error("用户停止")), 10);
      return new Response(null, { status: 429 });
    });
    const request = createDeepSeekWebClient({ apiKey: "test", fetch, signal: controller.signal });
    await expect(request("search", {}, schema)).rejects.toThrow("用户停止");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["generation", "tool"] as const)("%s 取消会传递到正在进行的 HTTP 请求", async (source) => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      receivedSignal = init?.signal;
      controller.abort(new Error("已取消"));
      receivedSignal?.throwIfAborted();
      return Response.json({ ok: true });
    });
    const request = createDeepSeekWebClient({ apiKey: "test", fetch, ...(source === "generation" ? { signal: controller.signal } : {}) });
    await expect(request("fetch", {}, schema, source === "tool" ? controller.signal : undefined)).rejects.toThrow("已取消");
    expect(receivedSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("超时覆盖整个请求和重试预算，返回去敏的超时错误", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      controller.abort(new Error("private timeout details"));
      init?.signal?.throwIfAborted();
      return Response.json({ ok: true });
    });
    await expect(createDeepSeekWebClient({ apiKey: "test", fetch })("fetch", {}, schema)).rejects.toThrow("DeepSeek fetch 请求超时（30 秒）");
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
