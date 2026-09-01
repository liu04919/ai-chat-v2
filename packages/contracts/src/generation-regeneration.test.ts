import { describe, expect, it } from "vitest";

import {
  regenerateGenerationRequestSchema,
  regenerateGenerationResponseSchema,
  regenerationErrorResponseSchema,
} from "./generation-regeneration";

describe("Generation regeneration contracts", () => {
  it("只接受 Conversation 与被替换的 Assistant Message ID", () => {
    const request = {
      conversationId: "conversation_example",
      assistantMessageId: "assistant_message_example",
    };

    expect(regenerateGenerationRequestSchema.parse(request)).toEqual(request);
    expect(() =>
      regenerateGenerationRequestSchema.parse({
        ...request,
        reasoningEffort: "high",
      }),
    ).toThrow();
  });

  it("复用标准 Generation 响应，并保留 Active Generation ID", () => {
    expect(
      regenerateGenerationResponseSchema.parse({
        conversationId: "conversation_example",
        generation: {
          id: "generation_example",
          userMessageId: "user_message_example",
          status: "queued",
          reasoningEffort: "medium",
          createdAt: "2026-09-01T10:00:00.000Z",
        },
      }),
    ).toMatchObject({ conversationId: "conversation_example" });
    expect(
      regenerationErrorResponseSchema.parse({
        code: "ACTIVE_GENERATION",
        activeGenerationId: "generation_active",
      }),
    ).toEqual({
      code: "ACTIVE_GENERATION",
      activeGenerationId: "generation_active",
    });
  });
});
