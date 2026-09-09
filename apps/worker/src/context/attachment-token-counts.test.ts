import type { ClaimedGenerationExecution } from "@ai-chat/db";
import { describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_TOKEN_VERSION,
  countSolImageTokens,
  createAttachmentTokenCounter,
  inspectAttachmentTokens,
} from "./attachment-token-counts";

const signal = () => new AbortController().signal;
const cached = {
  version: ATTACHMENT_TOKEN_VERSION,
  etag: '"v1"',
  kind: "image" as const,
  width: 512,
  height: 512,
  tokens: 308,
};
function execution(): ClaimedGenerationExecution {
  return {
    id: "g",
    conversationId: "c",
    userMessageId: "m",
    ownerId: "owner",
    mode: "chat",
    reasoningEffort: "medium",
    tools: { webSearch: false, mcpToolIds: [] },
    summary: null,
    messages: [
      {
        id: "m",
        sequence: 0,
        role: "user",
        parts: [{ type: "attachment", attachmentId: "a" }],
      },
    ],
    attachments: [
      {
        id: "a",
        status: "ready",
        objectKey: "private/a",
        originalName: "a.png",
        mediaType: "image/png",
        contextTokenCount: cached,
      },
    ],
  };
}
function setup(etag = '"v1"') {
  const storage = {
    headObject: vi.fn(async () => ({
      etag,
      sizeBytes: 1,
      contentType: "image/png",
    })),
    readObject: vi.fn(async () => new Uint8Array([1])),
  };
  const inspect = vi.fn(async () => cached);
  const save = vi.fn(async () => {});
  return {
    storage,
    inspect,
    save,
    count: createAttachmentTokenCounter({
      modelId: "gpt-5.6-sol",
      storage,
      inspect,
      save,
    }),
  };
}

describe("附件本地计数缓存", () => {
  it("图片按尺寸计数，不再所有图片固定 16k", async () => {
    expect(countSolImageTokens(512, 512)).toBe(308);
    expect(countSolImageTokens(1024, 1024)).toBe(1229);
    expect(() => countSolImageTokens(0, 512)).toThrow("INVALID_IMAGE_SIZE");
    expect(() => countSolImageTokens(10000, 10000)).toThrow("IMAGE_TOO_LARGE");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    expect(
      await inspectAttachmentTokens(png, "image/png", signal()),
    ).toMatchObject({ kind: "image", width: 1, height: 1, tokens: 2 });
  });

  it("ETag 与计数版本匹配时不下载、不解析、不写库", async () => {
    const { storage, inspect, save, count } = setup();
    expect((await count(execution(), signal())).get("a")).toBe(308);
    expect(storage.headObject).toHaveBeenCalledOnce();
    expect(storage.readObject).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("PDF 读取实际文本和页数，逐页计算而不是每份固定 64k", async () => {
    // 在内存构造两页文本 PDF，不依赖网络、OCR 或额外测试文件。
    const stream = "BT /F1 12 Tf 30 100 Td (Hello token cache) Tj ET";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (const [index, object] of objects.entries()) {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 8\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
      .join("")}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const count = await inspectAttachmentTokens(
      Buffer.from(pdf),
      "application/pdf",
      signal(),
    );
    expect(count.kind).toBe("pdf");
    if (count.kind !== "pdf") throw new Error("expected PDF");
    expect(count.pages).toBe(2);
    expect(count.textTokens).toBeGreaterThan(0);
    expect(count.tokens).toBe(count.textTokens + 6000);
    await expect(
      inspectAttachmentTokens(new Uint8Array(), "application/pdf", signal()),
    ).rejects.toThrow("INVALID_FILE_SIZE");
  });

  it.each(["etag", "version"])(
    "%s 改变后重新解析并绑定对象版本",
    async (reason) => {
      const input = execution();
      if (reason === "version")
        input.attachments[0]!.contextTokenCount = {
          ...cached,
          version: "outdated",
        };
      const etag = reason === "etag" ? '"v2"' : '"v1"';
      const { storage, save, count } = setup(etag);
      const abortSignal = signal();
      await count(input, abortSignal);
      expect(storage.readObject).toHaveBeenCalledWith(
        "private/a",
        abortSignal,
        etag,
      );
      expect(save).toHaveBeenCalledWith({
        ownerId: "owner",
        attachmentId: "a",
        count: { ...cached, etag },
      });
    },
  );

  it("没有附件、已取消和未就绪时不下载对象", async () => {
    const { storage, count } = setup();
    await expect(
      count({ ...execution(), messages: [] }, signal()),
    ).resolves.toEqual(new Map());
    await expect(
      count(execution(), AbortSignal.abort(new Error("stopped"))),
    ).rejects.toThrow("stopped");
    const input = execution();
    input.attachments = [];
    await expect(count(input, signal())).rejects.toThrow("NOT_READY");
    expect(storage.readObject).not.toHaveBeenCalled();
  });

  it("缓存写失败不丢掉本轮已得到的计数", async () => {
    const { save, count } = setup('"v2"');
    save.mockRejectedValueOnce(new Error("database unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await count(execution(), signal())).get("a")).toBe(308);
    } finally {
      warning.mockRestore();
    }
  });
});
