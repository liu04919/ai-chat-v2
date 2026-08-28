import { describe, expect, it } from "vitest";

import {
  generationEventCursorSchema,
  generationEventSchema,
} from "./generation-event";

describe("generationEventSchema", () => {
  it.each([
    { type: "generation.started", generationId: "generation_123" },
    {
      type: "text.delta",
      generationId: "generation_123",
      delta: "你好",
    },
    {
      type: "reasoning.delta",
      generationId: "generation_123",
      delta: "先分析问题",
    },
    { type: "generation.completed", generationId: "generation_123" },
    { type: "generation.failed", generationId: "generation_123" },
  ])("接受 $type", (event) => {
    expect(generationEventSchema.parse(event)).toEqual(event);
  });

  it("拒绝空 delta、未知事件和额外字段", () => {
    expect(() =>
      generationEventSchema.parse({
        type: "text.delta",
        generationId: "generation_123",
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
