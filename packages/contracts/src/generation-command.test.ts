import { describe, expect, it } from "vitest";

import {
  createGenerationRequestSchema,
  createGenerationResponseSchema,
  generationErrorResponseSchema,
  generationJobPayloadSchema,
} from "./generation-command";

describe("Generation command contracts", () => {
  it("接受新 Chat Conversation 的 Generation 命令", () => {
    const request = {
      target: { type: "new", mode: "chat" },
      userMessageId: "message_example",
      parts: [
        { type: "text", text: "解释 Redis Streams" },
        { type: "attachment", attachmentId: "attachment_example" },
      ],
      reasoningEffort: "medium",
    };

    expect(createGenerationRequestSchema.parse(request)).toEqual(request);
  });

  it("拒绝空白消息和重复 Attachment", () => {
    expect(() =>
      createGenerationRequestSchema.parse({
        target: { type: "new", mode: "chat" },
        userMessageId: "message_empty",
        parts: [{ type: "text", text: "   " }],
        reasoningEffort: "low",
      }),
    ).toThrow();

    expect(() =>
      createGenerationRequestSchema.parse({
        target: { type: "existing", conversationId: "conversation_example" },
        userMessageId: "message_duplicate_attachment",
        parts: [
          { type: "attachment", attachmentId: "attachment_example" },
          { type: "attachment", attachmentId: "attachment_example" },
        ],
        reasoningEffort: "high",
      }),
    ).toThrow();
  });

  it("响应返回导航与排队所需的稳定 ID", () => {
    const response = {
      conversationId: "conversation_example",
      generation: {
        id: "generation_example",
        userMessageId: "message_example",
        status: "queued",
        reasoningEffort: "medium",
        createdAt: "2026-08-27T12:00:00.000Z",
      },
    };

    expect(createGenerationResponseSchema.parse(response)).toEqual(response);
  });

  it("明确 Active Generation 与 Attachment 错误的附加信息", () => {
    expect(
      generationErrorResponseSchema.parse({
        code: "ACTIVE_GENERATION",
        activeGenerationId: "generation_active",
      }),
    ).toEqual({
      code: "ACTIVE_GENERATION",
      activeGenerationId: "generation_active",
    });
    expect(
      generationErrorResponseSchema.parse({
        code: "ATTACHMENT_NOT_READY",
        attachmentId: "attachment_pending",
      }),
    ).toEqual({
      code: "ATTACHMENT_NOT_READY",
      attachmentId: "attachment_pending",
    });
  });

  it("Worker job 只携带 Generation ID", () => {
    expect(
      generationJobPayloadSchema.parse({ generationId: "generation_example" }),
    ).toEqual({ generationId: "generation_example" });
  });
});
