import { describe, expect, it } from "vitest";

import { createConversation } from "./conversation";

describe("createConversation", () => {
  it("创建后保持 mode 不可变", () => {
    const conversation = createConversation({ id: " chat_123 ", mode: "chat" });

    expect(conversation).toEqual({ id: "chat_123", mode: "chat" });
    expect(Object.isFrozen(conversation)).toBe(true);
    expect(Reflect.set(conversation, "mode", "image")).toBe(false);
    expect(conversation.mode).toBe("chat");
  });

  it("拒绝空 id", () => {
    expect(() => createConversation({ id: "  ", mode: "chat" })).toThrow(
      "Conversation id 不能为空",
    );
  });
});
