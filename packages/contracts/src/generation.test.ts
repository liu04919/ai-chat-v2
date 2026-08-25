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
        activeGeneration: { id: "gen_123", status: "running" },
      }),
    ).toEqual({ activeGeneration: { id: "gen_123", status: "running" } });

    expect(() =>
      chatRuntimeStateSchema.parse({
        activeGeneration: { id: "gen_123", status: "completed" },
      }),
    ).toThrow();
  });

  it("允许没有 active Generation", () => {
    expect(chatRuntimeStateSchema.parse({ activeGeneration: null })).toEqual({
      activeGeneration: null,
    });
  });
});
