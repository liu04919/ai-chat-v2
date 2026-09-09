import { describe, expect, it } from "vitest";
import { createGenerationRequestSchema } from "./generation-command";
import {
  KNOWLEDGE_MAX_BYTES,
  deleteKnowledgeBaseResponseSchema,
  deleteKnowledgeDocumentResponseSchema,
  knowledgeBaseInputSchema,
  knowledgeDocumentSchema,
  knowledgeDocumentInputSchema,
  knowledgeErrorResponseSchema,
  knowledgeJobSchema,
  knowledgeSourceSchema,
  knowledgeSourcesPartSchema,
} from "./knowledge";

describe("知识库上传请求边界", () => {
  it.each(["text/plain", "text/markdown", "application/pdf"])(
    "接受受支持的文件元信息：%s",
    (mediaType) => {
      expect(
        knowledgeDocumentInputSchema.safeParse({
          originalName: "资料",
          mediaType,
          sizeBytes: 4,
        }).success,
      ).toBe(true);
    },
  );
  it.each([
    { sizeBytes: 0 },
    { sizeBytes: KNOWLEDGE_MAX_BYTES + 1 },
    { sizeBytes: 1.5 },
    { mediaType: "image/png" },
    { originalName: "" },
  ])("拒绝非法元信息：%j", (invalid) => {
    expect(
      knowledgeDocumentInputSchema.safeParse({
        originalName: "资料.txt",
        mediaType: "text/plain",
        sizeBytes: 4,
        ...invalid,
      }).success,
    ).toBe(false);
  });
  it("选库需要文本问题且不允许图片模式", () => {
    const input = {
      target: { type: "new", conversationId: "c", mode: "chat" },
      userMessageId: "u",
      parts: [{ type: "text", text: "问题" }],
      reasoningEffort: "medium",
      tools: { webSearch: false, mcpToolIds: [] },
      knowledgeBaseId: "kb",
    };
    expect(createGenerationRequestSchema.safeParse(input).success).toBe(true);
    expect(
      createGenerationRequestSchema.safeParse({
        ...input,
        target: { ...input.target, mode: "image" },
      }).success,
    ).toBe(false);
    expect(
      createGenerationRequestSchema.safeParse({
        ...input,
        parts: [{ type: "attachment", attachmentId: "a" }],
      }).success,
    ).toBe(false);
  });
});

describe("知识库公开协议", () => {
  it("创建知识库时整理名称，拒绝空名称和额外归属字段", () => {
    expect(knowledgeBaseInputSchema.parse({ name: "  学习资料  " })).toEqual({ name: "学习资料" });
    expect(knowledgeBaseInputSchema.safeParse({ name: "  " }).success).toBe(false);
    expect(knowledgeBaseInputSchema.safeParse({ name: "资料", ownerId: "other" }).success).toBe(false);
  });

  it.each(["uploading", "pending", "processing", "ready", "failed"])(
    "文档响应支持入库状态 %s，但不公开对象存储字段", (status) => {
      const document = {
        id: "doc", originalName: "资料.txt", mediaType: "text/plain", sizeBytes: 4,
        status, chunkCount: 0, errorCode: null, createdAt: "2026-09-09T00:00:00.000Z",
      };
      expect(knowledgeDocumentSchema.parse(document)).toEqual(document);
      expect(knowledgeDocumentSchema.safeParse({ ...document, objectKey: "private/key" }).success).toBe(false);
    },
  );

  it.each([
    "UNAUTHORIZED", "INVALID_REQUEST", "KNOWLEDGE_NOT_FOUND",
    "KNOWLEDGE_UPLOAD_NOT_FOUND", "KNOWLEDGE_METADATA_MISMATCH",
    "KNOWLEDGE_UPLOAD_FAILED", "KNOWLEDGE_OBJECT_DELETE_FAILED", "INTERNAL_ERROR",
  ])("HTTP 错误只接受已约定的 code：%s", (code) => {
    expect(knowledgeErrorResponseSchema.parse({ code })).toEqual({ code });
  });

  it.each([
    {}, { code: "UPSTREAM_SECRET_ERROR" }, { code: 500 },
    { code: "INTERNAL_ERROR", message: "内部异常详情" },
  ])("拒绝未知或携带内部详情的错误响应：%j", (response) => {
    expect(knowledgeErrorResponseSchema.safeParse(response).success).toBe(false);
  });

  it("删除文档响应仅包含 documentId，删除知识库保留清理警告", () => {
    expect(deleteKnowledgeDocumentResponseSchema.parse({ documentId: "doc" })).toEqual({ documentId: "doc" });
    for (const cleanupFailed of [false, true]) {
      expect(deleteKnowledgeBaseResponseSchema.parse({ baseId: "kb", cleanupFailed })).toEqual({ baseId: "kb", cleanupFailed });
    }
    expect(deleteKnowledgeBaseResponseSchema.safeParse({ baseId: "kb" }).success).toBe(false);
  });

  it.each([{}, { documentId: "" }, { documentId: 1 }, { documentId: "doc", objectKey: "private/key" }])(
    "拒绝不合规的删除文档响应：%j", (response) => {
      expect(deleteKnowledgeDocumentResponseSchema.safeParse(response).success).toBe(false);
    },
  );

  it("知识库任务只传文档 ID，不信任调用者附带的归属和正文", () => {
    expect(knowledgeJobSchema.parse({ documentId: "doc" })).toEqual({ documentId: "doc" });
    expect(knowledgeJobSchema.safeParse({ documentId: "doc", ownerId: "other", content: "正文" }).success).toBe(false);
  });

  it("引用允许空结果和第 18 条，不公开向量、评分或对象 key", () => {
    expect(knowledgeSourcesPartSchema.parse({ id: "sources", type: "knowledge-sources", sources: [] }).sources).toEqual([]);
    const source = { number: 18, chunkId: "chunk", documentId: "doc", originalName: "资料.txt", page: 1, content: "原文" };
    expect(knowledgeSourceSchema.parse(source)).toEqual(source);
    for (const number of [0, 19]) expect(knowledgeSourceSchema.safeParse({ ...source, number }).success).toBe(false);
    for (const extra of [{ embedding: [1] }, { score: 0.9 }, { objectKey: "private/key" }]) {
      expect(knowledgeSourceSchema.safeParse({ ...source, ...extra }).success).toBe(false);
    }
  });
});
