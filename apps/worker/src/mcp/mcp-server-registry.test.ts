import { describe, expect, it } from "vitest";

import {
  createConfiguredMcpServerRegistry,
  createMcpServerRegistry,
} from "./mcp-server-registry";

describe("MCP Server Registry", () => {
  it("只在服务端定义中保存连接密钥，对外摘要不包含连接信息", () => {
    const registry = createConfiguredMcpServerRegistry({
      FORTUNE_MCP_URL: "http://127.0.0.1:3100/mcp",
      FORTUNE_MCP_API_KEY: "fortune-secret",
      BAIDU_MAPS_API_KEY: "baidu-secret",
    });

    expect(registry.list()).toEqual([
      expect.objectContaining({ id: "fortune", source: "owned" }),
      expect.objectContaining({ id: "baidu-maps", source: "third-party" }),
    ]);
    expect(JSON.stringify(registry.list())).not.toContain("secret");
    expect(registry.get("fortune").connection.headers).toEqual({
      Authorization: "Bearer fortune-secret",
    });
    expect(registry.get("baidu-maps").connection.url).toContain(
      "ak=baidu-secret",
    );
  });

  it("fortune URL 与密钥必须同时配置", () => {
    expect(() =>
      createConfiguredMcpServerRegistry({
        FORTUNE_MCP_URL: "http://127.0.0.1:3100/mcp",
      }),
    ).toThrow("必须同时配置");
  });

  it("拒绝重复、不可命名空间化的 Server id", () => {
    const definition = {
      id: "fortune",
      title: "Fortune",
      description: "Fortune tools",
      source: "owned" as const,
      connection: {
        transport: "http" as const,
        url: "http://127.0.0.1:3100/mcp",
      },
    };

    expect(() => createMcpServerRegistry([definition, definition])).toThrow(
      "重复",
    );
    expect(() =>
      createMcpServerRegistry([{ ...definition, id: "Bad.Server" }]),
    ).toThrow("无效");
  });
});
