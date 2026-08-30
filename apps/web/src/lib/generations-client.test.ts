import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelGeneration,
  GenerationCancellationClientError,
} from "./generations-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cancelGeneration", () => {
  it("向编码后的 Generation cancel endpoint 发送 POST 并校验响应", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        generation: {
          id: "generation/123",
          status: "running",
          cancelRequestedAt: "2026-08-31T00:00:00.000Z",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(cancelGeneration("generation/123")).resolves.toEqual({
      generation: {
        id: "generation/123",
        status: "running",
        cancelRequestedAt: "2026-08-31T00:00:00.000Z",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/generations/generation%2F123/cancel",
      { method: "POST" },
    );
  });

  it("把服务端取消错误转换成用户可读错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          { code: "CANCEL_SIGNAL_UNAVAILABLE" },
          { status: 503 },
        ),
      ),
    );

    await expect(cancelGeneration("generation_123")).rejects.toEqual(
      expect.objectContaining<Partial<GenerationCancellationClientError>>({
        message: "暂时无法停止生成，请重试",
        response: { code: "CANCEL_SIGNAL_UNAVAILABLE" },
      }),
    );
  });
});
