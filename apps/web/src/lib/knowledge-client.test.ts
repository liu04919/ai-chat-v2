import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadKnowledgeFile } from "./knowledge-client";

const document = {
  id: "document-1",
  originalName: "资料.md",
  mediaType: "text/markdown",
  sizeBytes: 4,
  status: "uploading",
  chunkCount: 0,
  errorCode: null,
  createdAt: "2026-09-07T00:00:00.000Z",
};
const instruction = {
  document,
  upload: {
    method: "PUT",
    url: "https://r2.test/knowledge/test?signature=test",
    headers: { "Content-Type": "text/markdown" },
    expiresAt: "2026-09-07T00:05:00.000Z",
  },
};
afterEach(() => vi.unstubAllGlobals());

describe("知识库文件直传", () => {
  it("业务接口只收 JSON 元信息，文件发往 R2，成功后调用完成接口", async () => {
    const file = new File(["test"], "资料.md", {
      type: "application/octet-stream",
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(instruction))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ ...document, status: "pending" }));
    vi.stubGlobal("fetch", fetch);
    expect((await uploadKnowledgeFile("kb", file)).status).toBe("pending");
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/knowledge-bases/kb/documents",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originalName: "资料.md",
          mediaType: "text/markdown",
          sizeBytes: 4,
        }),
      },
    );
    expect(fetch).toHaveBeenNthCalledWith(2, instruction.upload.url, {
      method: "PUT",
      headers: instruction.upload.headers,
      body: file,
    });
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "/api/knowledge-bases/kb/documents/document-1/complete",
      { method: "POST" },
    );
  });

  it.each(["http", "network"])("直传失败不调用完成接口：%s", async (kind) => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(instruction));
    if (kind === "http")
      fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
    else fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetch);
    await expect(
      uploadKnowledgeFile("kb", new File(["test"], "资料.md")),
    ).rejects.toThrow("文件上传失败");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("后端核验失败不能被当作上传成功", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(instruction))
      .mockResolvedValueOnce(new Response(null))
      .mockResolvedValueOnce(
        Response.json({ code: "KNOWLEDGE_METADATA_MISMATCH" }, { status: 409 }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(
      uploadKnowledgeFile("kb", new File(["test"], "资料.md")),
    ).rejects.toThrow("大小或类型不匹配");
  });

  it.each([
    new File([], "empty.txt"),
    new File(["test"], "unsupported.png"),
    new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.pdf"),
  ])("非法文件不创建记录：$name", async (file) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(uploadKnowledgeFile("kb", file)).rejects.toThrow("请选择非空");
    expect(fetch).not.toHaveBeenCalled();
  });
});
