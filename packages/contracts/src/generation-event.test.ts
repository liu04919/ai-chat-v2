import { describe, expect, it } from "vitest";

import {
  generationEventCursorSchema,
  generationEventSchema,
} from "./generation-event";
import { knowledgeSourcesPartSchema } from "./knowledge";

describe("generationEventSchema", () => {
  it.each([6, 7, 18, 19])("来源快照与 SSE 对 %i 条来源使用相同上限", (count) => {
    const sources = Array.from({ length: count }, (_, index) => ({
      // 第 19 项沿用有效编号，确保测到的是列表长度限制。
      number: Math.min(index + 1, 18), chunkId: `chunk-${index}`,
      documentId: "doc", originalName: "资料", page: 1, content: "原文",
    }));
    expect(knowledgeSourcesPartSchema.safeParse({
      id: "sources", type: "knowledge-sources", sources,
    }).success).toBe(count <= 18);
    expect(generationEventSchema.safeParse({
      generationId: "generation_123", partId: "sources", type: "knowledge.sources", sources,
    }).success).toBe(count <= 18);
  });

  it.each([
    { type: "generation.started", generationId: "generation_123" },
    {
      type: "text.delta",
      generationId: "generation_123",
      partId: "text_123",
      delta: "你好",
    },
    {
      type: "reasoning.delta",
      generationId: "generation_123",
      partId: "reasoning_123",
      delta: "先分析问题",
    },
    {
      type: "tool.call",
      generationId: "generation_123",
      partId: "tool-call_123",
      toolCallId: "call_123",
      toolName: "web_search",
    },
    {
      type: "tool.result",
      generationId: "generation_123",
      partId: "tool-result_123",
      toolCallId: "call_123",
      isError: false,
    },
    { type: "generation.completed", generationId: "generation_123" },
    { type: "generation.failed", generationId: "generation_123" },
    { type: "generation.cancelled", generationId: "generation_123" },
  ])("接受 $type", (event) => {
    expect(generationEventSchema.parse(event)).toEqual(event);
  });

  it("拒绝空 delta、未知事件和额外字段", () => {
    expect(() =>
      generationEventSchema.parse({
        type: "text.delta",
        generationId: "generation_123",
        partId: "text_123",
        delta: "",
      }),
    ).toThrow();
    expect(() =>
      generationEventSchema.parse({
        type: "tool.called",
        generationId: "generation_123",
      }),
    ).toThrow();
    expect(() =>
      generationEventSchema.parse({
        type: "generation.completed",
        generationId: "generation_123",
        assistantMessageId: "message_123",
      }),
    ).toThrow();
    expect(() =>
      generationEventSchema.parse({
        type: "tool.call",
        generationId: "generation_123",
        partId: "tool-call_123",
        toolCallId: "call_123",
        toolName: "web_search",
        input: { query: "不应发送到浏览器" },
      }),
    ).toThrow();
    expect(() =>
      generationEventSchema.parse({
        type: "tool.result",
        generationId: "generation_123",
        partId: "tool-result_123",
        toolCallId: "call_123",
        output: { secret: "不应发送到浏览器" },
        isError: false,
      }),
    ).toThrow();
  });
});

describe("generationEventCursorSchema", () => {
  it("只接受 Redis Stream ID", () => {
    expect(generationEventCursorSchema.parse("1720000000000-0")).toBe(
      "1720000000000-0",
    );
    expect(() => generationEventCursorSchema.parse("latest")).toThrow();
  });
});
