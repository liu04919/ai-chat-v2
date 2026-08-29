import { describe, expect, it } from "vitest";

import {
  assistantMessagePartsSchema,
  messageSchema,
  userMessagePartsSchema,
} from "./message";

describe("User Message contracts", () => {
  it("只接受 text 与 attachment", () => {
    const parts = [
      { type: "text", text: "解释一下 React 并发渲染" },
      { type: "attachment", attachmentId: "attachment-1" },
    ];

    expect(userMessagePartsSchema.parse(parts)).toEqual(parts);
    expect(
      userMessagePartsSchema.safeParse([
        { id: "reasoning-1", type: "reasoning", text: "分析" },
      ]).success,
    ).toBe(false);
  });
});

describe("Assistant Message contracts", () => {
  it("按数组顺序保留 reasoning、tool 与 text 的交替结构", () => {
    const parts = [
      { id: "reasoning-1", type: "reasoning", text: "先查询天气" },
      {
        id: "tool-call-1",
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "getWeather",
        input: { city: "合肥" },
      },
      {
        id: "tool-result-1",
        type: "tool-result",
        toolCallId: "call-1",
        output: { temperature: 31 },
        isError: false,
      },
      { id: "reasoning-2", type: "reasoning", text: "根据结果回答" },
      { id: "text-1", type: "text", text: "合肥今天约 31℃。" },
    ];

    expect(assistantMessagePartsSchema.parse(parts)).toEqual(parts);
  });

  it("拒绝重复 part id 与 User Attachment 形状", () => {
    expect(
      assistantMessagePartsSchema.safeParse([
        { id: "part-1", type: "reasoning", text: "分析" },
        { id: "part-1", type: "text", text: "回答" },
      ]).success,
    ).toBe(false);
    expect(
      assistantMessagePartsSchema.safeParse([
        { type: "attachment", attachmentId: "attachment-1" },
      ]).success,
    ).toBe(false);
  });
});

describe("Message contract", () => {
  it("按 role 判别 User 与 Assistant Parts", () => {
    const userMessage = {
      id: "message-user",
      role: "user",
      parts: [{ type: "text", text: "你好" }],
      sequence: 0,
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    const assistantMessage = {
      id: "message-assistant",
      role: "assistant",
      parts: [
        { id: "reasoning-1", type: "reasoning", text: "先打招呼" },
        { id: "text-1", type: "text", text: "你好" },
      ],
      sequence: 1,
      createdAt: "2026-08-28T00:00:01.000Z",
    };

    expect(messageSchema.parse(userMessage)).toEqual(userMessage);
    expect(messageSchema.parse(assistantMessage)).toEqual(assistantMessage);
    expect(
      messageSchema.safeParse({
        ...userMessage,
        parts: [{ id: "reasoning-1", type: "reasoning", text: "分析" }],
      }).success,
    ).toBe(false);
  });
});
