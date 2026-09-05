import { describe, expect, it, vi } from "vitest";
import { validateKnowledgeVector, type KnowledgeHit } from "@ai-chat/db";
import { chunkPages, parseKnowledgeFile } from "./parse";
import { reciprocalRankFusion } from "./retrieve";
import { createKnowledgeEmbedder } from "./embedding";

describe("知识库解析与检索基线", () => {
  it("切块保留页内位置和重叠，不跨页", () => {
    const chunks = chunkPages(
      [
        { page: 1, text: "abcdefghij" },
        { page: 2, text: "xyz" },
      ],
      6,
      2,
    );
    expect(chunks).toEqual([
      { page: 1, start: 0, end: 6, content: "abcdef" },
      { page: 1, start: 4, end: 10, content: "efghij" },
      { page: 2, start: 0, end: 3, content: "xyz" },
    ]);
  });
  it("拒绝空文件、无文本、错误编码与失效切块参数", async () => {
    await expect(
      parseKnowledgeFile(new Uint8Array(), "text/plain"),
    ).rejects.toThrow("INVALID_FILE_SIZE");
    await expect(
      parseKnowledgeFile(new TextEncoder().encode("   "), "text/markdown"),
    ).rejects.toThrow("NO_EXTRACTABLE_TEXT");
    await expect(
      parseKnowledgeFile(new Uint8Array([255]), "text/plain"),
    ).rejects.toThrow();
    expect(() => chunkPages([], 10, 10)).toThrow("INVALID_CHUNK_SIZE");
  });
  it("Markdown 原文保留，不能偷偷截掉超过上限的 chunk", async () => {
    const text = "# 数据库\n向量检索";
    expect(
      (
        await parseKnowledgeFile(
          new TextEncoder().encode(text),
          "text/markdown",
        )
      )[0]?.content,
    ).toBe(text);
    expect(() =>
      chunkPages([{ page: 1, text: "x".repeat(1001) }], 1, 0),
    ).toThrow("DOCUMENT_TOO_LARGE");
  });
  it("校验模型维度、数值和配置", () => {
    expect(() => validateKnowledgeVector([1])).toThrow("INVALID_EMBEDDING");
    expect(() => validateKnowledgeVector(Array(1024).fill(0))).toThrow(
      "INVALID_EMBEDDING",
    );
    expect(() => validateKnowledgeVector(Array(1024).fill(NaN))).toThrow(
      "INVALID_EMBEDDING",
    );
    expect(() => createKnowledgeEmbedder({})).toThrow(
      "EMBEDDING_NOT_CONFIGURED",
    );
  });
  it("RRF 按排名融合，不混加两路原始分数", () => {
    const hit = (id: string, score: number): KnowledgeHit => ({
      id,
      score,
      documentId: "doc",
      originalName: "test",
      content: id,
      page: 1,
      start: 0,
      end: 1,
    });
    const result = reciprocalRankFusion([
      [hit("a", 0.1), hit("b", 0.2)],
      [hit("b", -20), hit("c", -5)],
    ]);
    expect(result.map((h) => h.id)).toEqual(["b", "a", "c"]);
    expect(result[0]?.score).toBeCloseTo(1 / 61 + 1 / 62);
  });
  it("切块边界不会切断 emoji", () => {
    expect(
      chunkPages([{ page: 1, text: "a😀b" }], 2, 1).map((c) => c.content),
    ).toEqual(["a😀", "b"]);
  });
  it("真实 PDF 解析器提取文本和页码", async () => {
    const stream = "BT /F1 12 Tf 20 100 Td (Knowledge database) Tj ET";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((object, index) => {
      offsets.push(pdf.length);
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
      .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const chunks = await parseKnowledgeFile(
      new TextEncoder().encode(pdf),
      "application/pdf",
    );
    expect(chunks[0]?.page).toBe(1);
    expect(chunks[0]?.content).toContain("Knowledge database");
  });
  it("Embedding 实际 SDK 请求按 10 条分批，传递 1024 维并保持顺序", async () => {
    const batches: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, options: RequestInit) => {
        const body = JSON.parse(options.body as string) as {
          input: string[];
          dimensions: number;
        };
        expect(body.dimensions).toBe(1024);
        batches.push(body.input.length);
        return Response.json({
          data: body.input.map((value, index) => ({
            index,
            embedding: [Number(value) + 1, ...Array(1023).fill(0)],
          })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }),
    );
    try {
      const embedder = createKnowledgeEmbedder({
        EMBEDDING_BASE_URL: "https://example.test/v1",
        DASHSCOPE_API_KEY: "test-key",
        EMBEDDING_MODEL: "test",
      });
      const result = await embedder.embed(
        Array.from({ length: 21 }, (_, i) => String(i)),
      );
      expect(batches).toEqual([10, 10, 1]);
      expect(result.map((v) => v[0])).toEqual(
        Array.from({ length: 21 }, (_, i) => i + 1),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
