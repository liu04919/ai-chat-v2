import { describe, expect, it } from "vitest";

import { messagePartsSchema, messageSchema } from "./message";

describe("messagePartsSchema", () => {
  it("接受当前协议允许的 text 与 attachment", () => {
    const parts = [
      { type: "text", text: "解释一下 React 并发渲染" },
      { type: "attachment", attachmentId: "attachment-1" },
    ];

    expect(messagePartsSchema.parse(parts)).toEqual(parts);
  });

  it("拒绝尚未进入 Message 协议的 tool part", () => {
    const result = messagePartsSchema.safeParse([
      { type: "tool", toolName: "webSearch" },
    ]);

    expect(result.success).toBe(false);
  });

  it("拒绝空 parts", () => {
    expect(messagePartsSchema.safeParse([]).success).toBe(false);
  });

  it("Message DTO 包含稳定顺序和创建时间", () => {
    const message = {
      id: "message_example",
      role: "user",
      parts: [{ type: "text", text: "你好" }],
      sequence: 0,
      createdAt: "2026-08-28T00:00:00.000Z",
    };

    expect(messageSchema.parse(message)).toEqual(message);
  });
});
