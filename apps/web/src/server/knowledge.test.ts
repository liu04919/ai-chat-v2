import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_MAX_BYTES,
  createGenerationRequestSchema,
  knowledgeDocumentInputSchema,
} from "@ai-chat/contracts";

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
