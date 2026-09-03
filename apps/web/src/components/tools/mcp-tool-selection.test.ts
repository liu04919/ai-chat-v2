import { describe, expect, it } from "vitest";

import {
  normalizeMcpToolIds,
  toggleMcpServerTools,
  toggleMcpTool,
} from "./mcp-tool-selection";

describe("MCP Tool selection", () => {
  it("去重并稳定排序具体 Tool ID", () => {
    expect(
      normalizeMcpToolIds([
        "fortune.tarot",
        "baidu-maps.weather",
        "fortune.tarot",
      ]),
    ).toEqual(["baidu-maps.weather", "fortune.tarot"]);
  });

  it("切换单个 Tool 时保留其他 Server 的选择", () => {
    expect(
      toggleMcpTool(
        ["fortune.tarot", "baidu-maps.weather"],
        "fortune.tarot",
        false,
      ),
    ).toEqual(["baidu-maps.weather"]);
  });

  it("Server 全选和清空最终仍展开为具体 Tool ID", () => {
    const selected = toggleMcpServerTools(
      ["fortune.tarot"],
      ["baidu-maps.weather", "baidu-maps.route"],
      true,
    );

    expect(selected).toEqual([
      "baidu-maps.route",
      "baidu-maps.weather",
      "fortune.tarot",
    ]);
    expect(
      toggleMcpServerTools(
        selected,
        ["baidu-maps.weather", "baidu-maps.route"],
        false,
      ),
    ).toEqual(["fortune.tarot"]);
  });
});
