import { describe, expect, it } from "vitest";

import { isActiveGenerationStatus } from "./generation";

describe("isActiveGenerationStatus", () => {
  it.each(["queued", "running"] as const)("把 %s 识别为 active", (status) => {
    expect(isActiveGenerationStatus(status)).toBe(true);
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "把 %s 识别为 terminal",
    (status) => {
      expect(isActiveGenerationStatus(status)).toBe(false);
    },
  );
});
