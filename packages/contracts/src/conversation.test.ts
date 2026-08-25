import { describe, expect, it } from "vitest";

import { createConversationRequestSchema } from "./conversation";

describe("createConversationRequestSchema", () => {
  it.each(["chat", "image"])("接受已定义的 %s mode", (mode) => {
    expect(createConversationRequestSchema.parse({ mode })).toEqual({ mode });
  });

  it("拒绝未知字段和未知 mode", () => {
    expect(() => createConversationRequestSchema.parse({ mode: "audio" })).toThrow();
    expect(() => createConversationRequestSchema.parse({ mode: "chat", model: "gpt" })).toThrow();
  });
});
