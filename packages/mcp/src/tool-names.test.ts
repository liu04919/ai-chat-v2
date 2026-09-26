import {
  createMcpToolId,
  parseMcpToolId,
  toMcpRuntimeToolName,
} from "@ai-chat/mcp/tool-names";
import { describe, expect, it, vi } from "vitest";

// 如果子路径意外经过包的 Client 入口，这些纯函数测试应立即失败。
vi.mock("@ai-sdk/mcp", () => {
  throw new Error("工具命名入口不应加载 MCP Client");
});

describe("MCP 工具命名", () => {
  it("公开 ID 创建与解析保持一致", () => {
    const id = createMcpToolId("fortune", "calculate_bazi_chart");
    expect(id).toBe("fortune.calculate_bazi_chart");
    expect(parseMcpToolId(id)).toEqual({
      serverId: "fortune",
      toolName: "calculate_bazi_chart",
    });
  });

  it("只按第一个分隔符拆分，保留工具名中的点", () => {
    expect(parseMcpToolId(createMcpToolId("reports", "daily.summary"))).toEqual({
      serverId: "reports",
      toolName: "daily.summary",
    });
  });

  it.each(["", "fortune", ".send", "fortune."])(
    "拒绝无效的公开 ID：%s",
    (id) => {
      expect(() => parseMcpToolId(id)).toThrow("无效的 MCP Tool ID");
    },
  );

  it("运行时名称保留命名空间及既有字符转换规则", () => {
    expect(toMcpRuntimeToolName("fortune", "calculate_bazi_chart")).toBe(
      "mcp__fortune__calculate_bazi_chart",
    );
    expect(toMcpRuntimeToolName("map-service", "route.plan/v2")).toBe(
      "mcp__map-service__route_plan_v2",
    );
  });
});
