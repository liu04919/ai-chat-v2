import { describe, expect, it } from "vitest";

import {
  conversationDetailResponseSchema,
  conversationListResponseSchema,
} from "./conversation";

const conversation = {
  id: "conversation_example",
  mode: "chat",
  title: "ReadableStream 如何工作",
  createdAt: "2026-08-26T10:00:00.000Z",
  updatedAt: "2026-08-26T10:05:00.000Z",
};

describe("Conversation response schemas", () => {
  it("接受列表响应", () => {
    expect(
      conversationListResponseSchema.parse({ conversations: [conversation] }),
    ).toEqual({ conversations: [conversation] });
  });

  it("接受包含 Active Generation 的详情响应", () => {
    const detail = {
      nextCursor: null,
      conversation,
      latestGeneration: { id: "generation_example", status: "running" },
      activeGeneration: {
        id: "generation_example",
        status: "running",
        cancelRequestedAt: null,
      },
      messages: [
        {
          id: "message_example",
          role: "user",
          parts: [{ type: "text", text: "ReadableStream 如何工作" }],
          sequence: 0,
          createdAt: "2026-08-26T10:00:00.000Z",
        },
        {
          id: "message_assistant_example",
          role: "assistant",
          parts: [
            {
              id: "reasoning_example",
              type: "reasoning",
              text: "先梳理读取顺序",
            },
            {
              id: "text_example",
              type: "text",
              text: "ReadableStream 支持逐块读取。",
            },
          ],
          sequence: 1,
          createdAt: "2026-08-26T10:05:00.000Z",
        },
      ],
    };

    expect(conversationDetailResponseSchema.parse(detail)).toEqual(detail);
  });

  it("拒绝未知 mode、无效时间与额外字段", () => {
    expect(() =>
      conversationListResponseSchema.parse({
        conversations: [{ ...conversation, mode: "audio" }],
      }),
    ).toThrow();
    expect(() =>
      conversationListResponseSchema.parse({
        conversations: [{ ...conversation, updatedAt: "刚刚" }],
      }),
    ).toThrow();
    expect(() =>
      conversationDetailResponseSchema.parse({
        conversation,
        activeGeneration: null,
        latestGeneration: null,
        messages: [],
        model: "gpt-5.6-sol",
      }),
    ).toThrow();
  });

  it("最近一次 Generation 可为终态，但不能充当 Active Generation", () => {
    for (const status of ["completed", "failed", "cancelled"]) {
      const detail = {
        nextCursor: null,
        conversation,
        activeGeneration: null,
        latestGeneration: { id: "g1", status },
        messages: [],
      };
      expect(conversationDetailResponseSchema.parse(detail)).toEqual(detail);
      expect(() =>
        conversationDetailResponseSchema.parse({
          ...detail,
          activeGeneration: {
            id: "g1",
            status,
            cancelRequestedAt: null,
          },
        }),
      ).toThrow();
    }
  });
});
