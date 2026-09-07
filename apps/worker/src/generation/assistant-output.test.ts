import { describe, expect, it, vi } from "vitest";
import type {
  GenerationEventDto,
  KnowledgeSourceDto,
} from "@ai-chat/contracts";
import { createAssistantOutput } from "./assistant-output";

const sources: KnowledgeSourceDto[] = [
  {
    number: 1,
    chunkId: "chunk",
    documentId: "doc",
    originalName: "资料.md",
    page: 1,
    content: "原文",
  },
];

function setup() {
  const events: GenerationEventDto[] = [];
  const append = vi.fn(async (event: GenerationEventDto) => {
    events.push(event);
    return `${events.length}-0`;
  });
  return {
    output: createAssistantOutput({
      generationId: "g",
      eventWriter: { append },
    }),
    events,
    append,
  };
}

describe("回答收集器", () => {
  it("按顺序保存引用、思考和文字；合并连续 delta，但展示事件保持原有粒度", async () => {
    const { output, events } = setup();
    await output.appendSources(sources);
    await output.consume({ type: "reasoning", partId: "r", delta: "先想" });
    await output.consume({ type: "text", partId: "t", delta: "答" });
    await output.consume({ type: "text", partId: "t", delta: "案" });
    await output.consume({ type: "finish", reason: "stop" });
    expect(output.getCompletedParts()).toEqual([
      { id: "knowledge-g", type: "knowledge-sources", sources },
      { id: "r", type: "reasoning", text: "先想" },
      { id: "t", type: "text", text: "答案" },
    ]);
    expect(events.map((e) => e.type)).toEqual([
      "knowledge.sources",
      "reasoning.delta",
      "text.delta",
      "text.delta",
    ]);
    // finish 不是 generation.completed；终态必须由主流程落库成功后发布。
    expect(events.some((e) => e.type === "generation.completed")).toBe(false);
  });

  it("完整 Tool 参数和结果只进入服务端 Parts，事件只包含展示字段", async () => {
    const { output, events } = setup();
    await output.consume(
      {
        type: "tool-call",
        partId: "call",
        toolCallId: "c",
        toolName: "runtime_1",
        input: { query: "private query" },
      },
      () => "mcp:public",
    );
    await output.consume({
      type: "tool-result",
      partId: "result",
      toolCallId: "c",
      output: { privateResult: "secret" },
      isError: false,
    });
    expect(output.getParts()).toEqual([
      {
        id: "call",
        type: "tool-call",
        toolCallId: "c",
        toolName: "mcp:public",
        input: { query: "private query" },
      },
      {
        id: "result",
        type: "tool-result",
        toolCallId: "c",
        output: { privateResult: "secret" },
        isError: false,
      },
    ]);
    expect(events).toEqual([
      {
        type: "tool.call",
        generationId: "g",
        partId: "call",
        toolCallId: "c",
        toolName: "mcp:public",
      },
      {
        type: "tool.result",
        generationId: "g",
        partId: "result",
        toolCallId: "c",
        isError: false,
      },
    ]);
  });

  it("保留原来的 JSON 规范化：undefined 转 null，Error 保留 message", async () => {
    const { output } = setup();
    await output.consume({
      type: "tool-call",
      partId: "call",
      toolCallId: "c",
      toolName: "tool",
      input: undefined,
    });
    await output.consume({
      type: "tool-result",
      partId: "result",
      toolCallId: "c",
      output: new Error("failed"),
      isError: true,
    });
    expect(output.getParts()[0]).toMatchObject({
      input: null,
      toolName: "tool",
    });
    expect(output.getParts()[1]).toMatchObject({
      output: { message: "failed" },
      isError: true,
    });
  });

  it("拒绝重复引用、片段类型漂移和非连续复用 ID", async () => {
    const { output } = setup();
    await output.appendSources(sources);
    await expect(output.appendSources(sources)).rejects.toThrow("重复出现");
    await output.consume({ type: "text", partId: "a", delta: "A" });
    await expect(
      output.consume({ type: "reasoning", partId: "a", delta: "wrong" }),
    ).rejects.toThrow("改变了类型");
    await output.consume({ type: "text", partId: "b", delta: "B" });
    await expect(
      output.consume({ type: "text", partId: "a", delta: "wrong" }),
    ).rejects.toThrow("非连续");
  });

  it("事件写入失败仍保留已累计片段，异常交回主流程决定终态", async () => {
    const append = vi.fn(async () => {
      throw new Error("redis unavailable");
    });
    const output = createAssistantOutput({
      generationId: "g",
      eventWriter: { append },
    });
    await expect(
      output.consume({ type: "text", partId: "a", delta: "部分回答" }),
    ).rejects.toThrow("redis unavailable");
    expect(output.getParts()).toEqual([
      { id: "a", type: "text", text: "部分回答" },
    ]);
  });

  it("没有 finish 时只能读取部分回答，各收集器状态独立", async () => {
    const { output } = setup();
    await output.consume({ type: "text", partId: "a", delta: "部分回答" });
    expect(() => output.getCompletedParts()).toThrow("generation.finish");
    const copy = output.getParts();
    copy.length = 0;
    expect(output.getParts()).toHaveLength(1);
    const other = setup().output;
    expect(other.getParts()).toEqual([]);
    await other.consume({ type: "finish", reason: "stop" });
    expect(other.getCompletedParts()).toEqual([]);
    expect(() => output.getCompletedParts()).toThrow("generation.finish");
  });
});
