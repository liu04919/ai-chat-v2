import { describe, expect, it } from "vitest";

import { toAssistantMessageViewParts } from "./conversations";

describe("toAssistantMessageViewParts", () => {
  it("只向浏览器暴露 Tool 生命周期，不暴露输入和结果", () => {
    expect(
      toAssistantMessageViewParts([
        { id: "reasoning-1", type: "reasoning", text: "先搜索" },
        {
          id: "tool-call-1",
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "web_search",
          input: { query: "内部查询" },
        },
        {
          id: "tool-result-1",
          type: "tool-result",
          toolCallId: "call-1",
          output: { secret: "仅供模型读取" },
          isError: false,
        },
        { id: "text-1", type: "text", text: "搜索完成" },
      ]),
    ).toEqual([
      { id: "reasoning-1", type: "reasoning", text: "先搜索" },
      {
        id: "tool-call-1",
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "web_search",
      },
      {
        id: "tool-result-1",
        type: "tool-result",
        toolCallId: "call-1",
        isError: false,
      },
      { id: "text-1", type: "text", text: "搜索完成" },
    ]);
  });
});
