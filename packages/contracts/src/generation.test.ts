import { describe, expect, it } from "vitest";

import { chatRuntimeStateSchema, generationStatusSchema } from "./generation";

describe("generationStatusSchema", () => {
  it.each(["queued", "running", "completed", "failed", "cancelled"])(
    "接受 %s",
    (status) => {
      expect(generationStatusSchema.parse(status)).toBe(status);
    },
  );
});

describe("chatRuntimeStateSchema", () => {
  it("只允许 queued 或 running 作为 active Generation", () => {
    expect(
      chatRuntimeStateSchema.parse({
        activeGeneration: {
          id: "gen_123",
          status: "running",
          cancelRequestedAt: null,
          replacesAssistantMessageId: null,
        },
      }),
    ).toEqual({
      activeGeneration: {
        id: "gen_123",
        status: "running",
        cancelRequestedAt: null,
        replacesAssistantMessageId: null,
      },
    });

    expect(() =>
      chatRuntimeStateSchema.parse({
        activeGeneration: {
          id: "gen_123",
          status: "completed",
          cancelRequestedAt: null,
          replacesAssistantMessageId: null,
        },
      }),
    ).toThrow();
  });

  it("允许没有 active Generation", () => {
    expect(chatRuntimeStateSchema.parse({ activeGeneration: null })).toEqual({
      activeGeneration: null,
    });
  });
});
