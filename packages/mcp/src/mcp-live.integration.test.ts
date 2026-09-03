import { describe, expect, it } from "vitest";

import { createConfiguredMcpServerRegistry } from "./mcp-server-registry";
import { createMcpToolCatalog } from "./mcp-tool-catalog";

const runLiveTest = process.env.MCP_LIVE_TEST === "1" ? it : it.skip;

describe("remote MCP live integration", () => {
  runLiveTest("发现 fortune MCP 的三个工具", async () => {
    const registry = createConfiguredMcpServerRegistry(process.env);
    const catalog = createMcpToolCatalog({ registry });

    const result = await catalog.discoverServerTools("fortune", {
      forceRefresh: true,
    });

    expect(result.tools.map((tool) => tool.id).sort()).toEqual([
      "fortune.calculate_bazi_chart",
      "fortune.draw_tarot_reading",
      "fortune.get_daily_almanac",
    ]);
  });
});
