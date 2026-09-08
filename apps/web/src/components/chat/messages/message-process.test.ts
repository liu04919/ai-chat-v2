import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageProcess } from "./message-process";
import type { ProcessPart } from "./message-display";

const parts: ProcessPart[] = [
  { id: "r1", type: "reasoning", text: "先分析" },
  { id: "call", type: "tool-call", toolCallId: "c", toolName: "search_knowledge" },
  { id: "result", type: "tool-result", toolCallId: "c", isError: false },
  { id: "r2", type: "reasoning", text: "再分析" },
];
const renderReasoning = (text: string) => createElement("p", null, text);

describe("顶部思考过程折叠栏", () => {
  it("只有一个标题，所有思考和工具状态都在同一个 details 中", () => {
    const html = renderToStaticMarkup(createElement(MessageProcess, { parts, renderReasoning }));
    expect(html.match(/<details/g)).toHaveLength(1);
    expect(html.match(/思考过程/g)).toHaveLength(1);
    const positions = ["先分析", "search_knowledge", "工具执行完成", "再分析", "</details>"].map((text) => html.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).not.toContain('open=""');
  });

  it("流式自动展开，历史展开状态使用首个片段的稳定 ID", () => {
    for (const state of [{ isStreaming: true }, { expandedReasoningIds: new Set(["r1"]) }]) {
      const html = renderToStaticMarkup(createElement(MessageProcess, { parts, renderReasoning, ...state }));
      expect(html).toContain('open=""');
    }
  });

  it("无过程或仅空白思考不显示空标题，只有工具失败也能展示", () => {
    for (const empty of [[], [{ id: "r", type: "reasoning" as const, text: "  " }]]) {
      expect(renderToStaticMarkup(createElement(MessageProcess, { parts: empty, renderReasoning }))).toBe("");
    }
    const error: ProcessPart = { id: "e", type: "tool-result", toolCallId: "c", isError: true };
    const html = renderToStaticMarkup(createElement(MessageProcess, { parts: [error], renderReasoning }));
    expect(html).toContain("思考过程");
    expect(html).toContain("工具执行失败");
  });
});
