import { toMcpRuntimeToolName } from "@ai-chat/mcp/tool-names";
import { describe, expect, it } from "vitest";
import { toModelMessages } from "./history";
import {
  KNOWLEDGE_SEARCH_TOOL_NAME,
  toRuntimeHistoryToolName,
} from "./tool-names";

describe("历史工具名称转换", () => {
  it.each(["web_search", KNOWLEDGE_SEARCH_TOOL_NAME, "mcp__fortune__calculate"])(
    "非公开 MCP ID 保持原名：%s",
    (name) => {
      expect(toRuntimeHistoryToolName(name)).toBe(name);
    },
  );

  it("MCP 历史使用与本轮工具装配相同的运行时名称", () => {
    const runtimeName = toMcpRuntimeToolName("fortune", "calculate_bazi_chart");
    expect(toRuntimeHistoryToolName("fortune.calculate_bazi_chart")).toBe(
      runtimeName,
    );
    expect(
      toModelMessages({
        role: "assistant",
        parts: [
          {
            id: "call",
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "fortune.calculate_bazi_chart",
            input: { year: 2000 },
          },
          {
            id: "result",
            type: "tool-result",
            toolCallId: "call-1",
            output: { ok: true },
            isError: false,
          },
        ],
      }),
    ).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: runtimeName,
            input: { year: 2000 },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: runtimeName,
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
    ]);
  });
});
