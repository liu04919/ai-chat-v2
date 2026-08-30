import type { GenerationEventDto } from "@ai-chat/contracts";
import { describe, expect, it } from "vitest";

import {
  createGenerationProjection,
  reduceGenerationEvents,
} from "./generation-projection";

const generationId = "generation_123";

describe("Generation projection", () => {
  it("按 part 首次出现的顺序保留 reasoning 与 text 的交替结构", () => {
    const events: GenerationEventDto[] = [
      { type: "generation.started", generationId },
      {
        type: "reasoning.delta",
        generationId,
        partId: "reasoning_1",
        delta: "先分析",
      },
      {
        type: "text.delta",
        generationId,
        partId: "text_1",
        delta: "先回答一部分",
      },
      {
        type: "reasoning.delta",
        generationId,
        partId: "reasoning_2",
        delta: "再分析",
      },
      {
        type: "text.delta",
        generationId,
        partId: "text_2",
        delta: "最后回答",
      },
      { type: "generation.completed", generationId },
    ];

    const projection = reduceGenerationEvents(
      createGenerationProjection("conversation_123", generationId),
      events,
    );

    expect(projection.status).toBe("completed");
    expect(projection.parts).toEqual([
      { id: "reasoning_1", type: "reasoning", text: "先分析" },
      { id: "text_1", type: "text", text: "先回答一部分" },
      { id: "reasoning_2", type: "reasoning", text: "再分析" },
      { id: "text_2", type: "text", text: "最后回答" },
    ]);
  });

  it("把同一 part 的多段 delta 合并为一次投影更新结果", () => {
    const projection = reduceGenerationEvents(
      createGenerationProjection("conversation_123", generationId),
      [
        {
          type: "text.delta",
          generationId,
          partId: "text_1",
          delta: "你",
        },
        {
          type: "text.delta",
          generationId,
          partId: "text_1",
          delta: "好",
        },
      ],
    );

    expect(projection.parts).toEqual([
      { id: "text_1", type: "text", text: "你好" },
    ]);
  });

  it("拒绝 Generation 不一致和 part 类型漂移的事件", () => {
    const initial = createGenerationProjection(
      "conversation_123",
      generationId,
    );
    const wrongGeneration = reduceGenerationEvents(initial, [
      {
        type: "text.delta",
        generationId: "generation_other",
        partId: "text_1",
        delta: "错误",
      },
    ]);
    const wrongPartType = reduceGenerationEvents(initial, [
      {
        type: "text.delta",
        generationId,
        partId: "part_1",
        delta: "正文",
      },
      {
        type: "reasoning.delta",
        generationId,
        partId: "part_1",
        delta: "思考",
      },
    ]);

    expect(wrongGeneration.status).toBe("connection-error");
    expect(wrongPartType.status).toBe("connection-error");
  });
});
