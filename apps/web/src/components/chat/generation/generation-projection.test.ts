import type { GenerationEventDto } from "@ai-chat/contracts";
import { describe, expect, it } from "vitest";

import {
  createGenerationProjection,
  reduceGenerationEvents,
} from "./generation-projection";

const generationId = "generation_123";

describe("Generation projection", () => {
  it("重复来源事件更新同一累计快照，重放不会重复展示", () => {
    const first = { number: 1, chunkId: "c1", documentId: "d", originalName: "资料", page: 1, content: "原文" };
    const second = { ...first, number: 7, chunkId: "c7" };
    const event: GenerationEventDto = { type: "knowledge.sources", generationId, partId: "sources", sources: [first, second] };
    const projection = reduceGenerationEvents(createGenerationProjection("c", generationId), [
      { ...event, sources: [first] },
      { type: "text.delta", generationId, partId: "answer", delta: "回答" },
      event, event,
    ]);
    expect(projection.status).toBe("running");
    expect(projection.parts).toEqual([
      { id: "sources", type: "knowledge-sources", sources: [first, second] },
      { id: "answer", type: "text", text: "回答" },
    ]);
  });
  it("检索引用事件和文本按流顺序投影，引用保留原文快照", () => {
    const sources = [{ number: 1, chunkId: "chunk", documentId: "doc", originalName: "资料.md", page: 1, content: "原文" }];
    const projection = reduceGenerationEvents(createGenerationProjection("conversation_123", generationId), [
      { type: "generation.started", generationId },
      { type: "knowledge.sources", generationId, partId: "sources", sources },
      { type: "text.delta", generationId, partId: "answer", delta: "回答[1](#knowledge-1)" },
      { type: "generation.completed", generationId },
    ]);
    expect(projection.parts).toEqual([
      { id: "sources", type: "knowledge-sources", sources },
      { id: "answer", type: "text", text: "回答[1](#knowledge-1)" },
    ]);
    expect(projection.status).toBe("completed");
  });
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

  it("保留取消前的 partial parts，并进入 cancelled 终态", () => {
    const projection = reduceGenerationEvents(
      createGenerationProjection("conversation_123", generationId),
      [
        {
          type: "reasoning.delta",
          generationId,
          partId: "reasoning_1",
          delta: "正在分析",
        },
        { type: "generation.cancelled", generationId },
      ],
    );

    expect(projection.status).toBe("cancelled");
    expect(projection.parts).toEqual([
      { id: "reasoning_1", type: "reasoning", text: "正在分析" },
    ]);
  });

  it("按流顺序投影 Tool Call、Tool Result 与后续文本", () => {
    const projection = reduceGenerationEvents(
      createGenerationProjection("conversation_123", generationId),
      [
        {
          type: "tool.call",
          generationId,
          partId: "tool-call:call-1",
          toolCallId: "call-1",
          toolName: "web_search",
        },
        {
          type: "tool.result",
          generationId,
          partId: "tool-result:call-1",
          toolCallId: "call-1",
          isError: false,
        },
        {
          type: "text.delta",
          generationId,
          partId: "text-1",
          delta: "查询完成",
        },
      ],
    );

    expect(projection.parts).toEqual([
      {
        id: "tool-call:call-1",
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "web_search",
      },
      {
        id: "tool-result:call-1",
        type: "tool-result",
        toolCallId: "call-1",
        isError: false,
      },
      { id: "text-1", type: "text", text: "查询完成" },
    ]);
  });
});
