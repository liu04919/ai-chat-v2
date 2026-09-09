import { describe, expect, it } from "vitest";

import { activeGenerationSchema, generationStatusSchema } from "./generation";

describe("generationStatusSchema", () => {
  it.each(["queued", "running", "completed", "failed", "cancelled"])(
    "接受 %s",
    (status) => {
      expect(generationStatusSchema.parse(status)).toBe(status);
    },
  );
});

describe("activeGenerationSchema", () => {
  it.each(["queued", "running"])("接受活跃状态 %s", (status) => {
    const generation = { id: "gen_123", status, cancelRequestedAt: null };
    expect(activeGenerationSchema.parse(generation)).toEqual(generation);
  });

  it.each(["completed", "failed", "cancelled"])("终态 %s 不能作为 active Generation", (status) => {
    expect(() => activeGenerationSchema.parse({
      id: "gen_123", status, cancelRequestedAt: null,
    })).toThrow();
  });
});
