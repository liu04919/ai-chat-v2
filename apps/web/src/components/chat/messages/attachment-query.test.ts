import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { attachmentQueryOptions } from "./attachment-query";

const response = {
  attachment: {
    id: "a1",
    originalName: "image.png",
    mediaType: "image/png",
    status: "ready",
    sizeBytes: 1024,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  },
  download: {
    url: "https://example.com/image?signature=one",
    expiresAt: "2026-08-31T00:05:00.000Z",
  },
};
const client = new QueryClient({
  defaultOptions: { queries: { gcTime: Infinity } },
});
afterEach(() => {
  client.clear();
  vi.unstubAllGlobals();
});

describe("附件读取 Query", () => {
  it("并行渲染同一附件只读取一次，短期缓存后可主动刷新签名", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);
    const options = attachmentQueryOptions("a1");
    const values = await Promise.all([
      client.fetchQuery(options),
      client.fetchQuery(options),
    ]);
    expect(values).toEqual([response, response]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/attachments/a1", {
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...response,
        download: {
          ...response.download,
          url: "https://example.com/image?signature=two",
        },
      }),
    );
    await client.invalidateQueries({ queryKey: options.queryKey });
    expect((await client.fetchQuery(options)).download.url).toContain("two");
  });
  it("未授权或读取失败不会自动无限重试", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ code: "ATTACHMENT_NOT_FOUND" }, { status: 404 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      client.fetchQuery(attachmentQueryOptions("other")),
    ).rejects.toMatchObject({ code: "ATTACHMENT_NOT_FOUND" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
