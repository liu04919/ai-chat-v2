import { describe, expect, it } from "vitest";

import { createConversationTitle } from "./conversation-title";

describe("createConversationTitle", () => {
  it("使用第一段非空文本并压缩空白", () => {
    expect(
      createConversationTitle([
        { type: "text", text: "   " },
        { type: "text", text: "解释一下\n Redis   Streams" },
      ]),
    ).toBe("解释一下 Redis Streams");
  });

  it("按 Unicode 字符截取 30 个字符", () => {
    expect(
      Array.from(
        createConversationTitle([
          { type: "text", text: "这是一个需要被截断的会话标题".repeat(4) },
        ]),
      ),
    ).toHaveLength(30);
  });

  it("只有附件时使用稳定标题", () => {
    expect(
      createConversationTitle([
        { type: "attachment", attachmentId: "attachment_example" },
      ]),
    ).toBe("附件对话");
  });
});
