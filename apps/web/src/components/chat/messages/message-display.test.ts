import type { AssistantMessageViewPartsDto } from "@ai-chat/contracts";
import { describe, expect, it } from "vitest";
import { splitMessageDisplay } from "./message-display";

const parts: AssistantMessageViewPartsDto = [
  { id: "r1", type: "reasoning", text: "先分析" },
  { id: "t1", type: "text", text: "先说明" },
  { id: "call", type: "tool-call", toolCallId: "c1", toolName: "search_knowledge" },
  { id: "result", type: "tool-result", toolCallId: "c1", isError: false },
  { id: "sources", type: "knowledge-sources", sources: [] },
  { id: "r2", type: "reasoning", text: "再分析" },
  { id: "t2", type: "text", text: "最终回答" },
];

describe("消息展示分组", () => {
  it("多步思考和工具按原顺序归入一个过程，正文与引用保持独立", () => {
    const before = structuredClone(parts);
    const { processParts, contentParts } = splitMessageDisplay(parts);
    expect(processParts.map((p) => p.id)).toEqual(["r1", "call", "result", "r2"]);
    expect(contentParts.map((p) => "id" in p ? p.id : null)).toEqual(["t1", "sources", "t2"]);
    expect(parts).toEqual(before);
    expect(processParts[0]).toBe(parts[0]);
  });

  it("流式逐步追加仍使用首个过程 ID，刷新后的完整分组一致", () => {
    for (let end = 1; end <= parts.length; end++) {
      expect(splitMessageDisplay(parts.slice(0, end)).processParts[0]?.id).toBe("r1");
    }
    expect(splitMessageDisplay(JSON.parse(JSON.stringify(parts)))).toEqual(splitMessageDisplay(parts));
  });

  it("没有 reasoning 时，工具调用、失败状态仍归入过程", () => {
    const input: AssistantMessageViewPartsDto = [
      { id: "call", type: "tool-call", toolCallId: "c", toolName: "web_search" },
      { id: "error", type: "tool-result", toolCallId: "c", isError: true },
      { id: "answer", type: "text", text: "调用失败" },
    ];
    expect(splitMessageDisplay(input).processParts).toEqual(input.slice(0, 2));
  });

  it("普通文本和附件不生成思考过程，空流也不会生成", () => {
    const input = [{ type: "text" as const, text: "你好" }, { type: "attachment" as const, attachmentId: "file" }];
    expect(splitMessageDisplay(input)).toEqual({ processParts: [], contentParts: input });
    expect(splitMessageDisplay([])).toEqual({ processParts: [], contentParts: [] });
  });
});
