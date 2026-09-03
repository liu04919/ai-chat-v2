import type { ListToolsResult } from "@ai-sdk/mcp";
import { describe, expect, it, vi } from "vitest";

import { createMcpServerRegistry } from "./mcp-server-registry";
import {
  createMcpToolCatalog,
  type McpClientFactory,
} from "./mcp-tool-catalog";

function createRegistry() {
  return createMcpServerRegistry([
    {
      id: "fortune",
      title: "传统文化与塔罗",
      description: "Fortune tools",
      source: "owned",
      connection: {
        transport: "http",
        url: "http://127.0.0.1:3100/mcp",
      },
    },
  ]);
}

function page(
  tools: ListToolsResult["tools"],
  nextCursor?: string,
): ListToolsResult {
  return { tools, ...(nextCursor ? { nextCursor } : {}) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}

describe("MCP Tool Catalog", () => {
  it("读取全部分页并为工具生成稳定命名空间", async () => {
    const listTools = vi
      .fn()
      .mockResolvedValueOnce(
        page(
          [
            {
              name: "calculate_bazi_chart",
              title: "计算八字命盘",
              inputSchema: { type: "object" },
            },
          ],
          "next-page",
        ),
      )
      .mockResolvedValueOnce(
        page([
          {
            name: "draw_tarot_reading",
            inputSchema: { type: "object" },
          },
        ]),
      );
    const close = vi.fn().mockResolvedValue(undefined);
    const clientFactory: McpClientFactory = vi
      .fn()
      .mockResolvedValue({ listTools, close });
    const catalog = createMcpToolCatalog({
      registry: createRegistry(),
      clientFactory,
    });

    const result = await catalog.discoverServerTools("fortune");

    expect(result.tools.map((tool) => tool.id)).toEqual([
      "fortune.calculate_bazi_chart",
      "fortune.draw_tarot_reading",
    ]);
    expect(listTools).toHaveBeenNthCalledWith(2, {
      params: { cursor: "next-page" },
      options: { timeout: 10_000 },
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("在 TTL 内复用缓存，并合并同时发生的发现请求", async () => {
    const firstPage = deferred<ListToolsResult>();
    const secondPage = deferred<ListToolsResult>();
    const listTools = vi
      .fn()
      .mockReturnValueOnce(firstPage.promise)
      .mockReturnValueOnce(secondPage.promise);
    const close = vi.fn().mockResolvedValue(undefined);
    const clientFactory: McpClientFactory = vi
      .fn()
      .mockResolvedValue({ listTools, close });
    let now = 1_000;
    const catalog = createMcpToolCatalog({
      registry: createRegistry(),
      clientFactory,
      cacheTtlMs: 500,
      now: () => now,
    });

    const first = catalog.discoverServerTools("fortune");
    const concurrent = catalog.discoverServerTools("fortune");
    firstPage.resolve(page([]));

    expect(await first).toBe(await concurrent);
    expect(clientFactory).toHaveBeenCalledOnce();

    expect(await catalog.discoverServerTools("fortune")).toEqual(await first);
    expect(clientFactory).toHaveBeenCalledOnce();

    now = 1_501;
    const expired = catalog.discoverServerTools("fortune");
    secondPage.resolve(page([]));
    await expired;
    expect(clientFactory).toHaveBeenCalledTimes(2);
  });

  it("发现失败时关闭 Client，且不缓存失败", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const clientFactory: McpClientFactory = vi
      .fn()
      .mockResolvedValue({
        listTools: vi.fn().mockRejectedValue(new Error("offline")),
        close,
      });
    const catalog = createMcpToolCatalog({
      registry: createRegistry(),
      clientFactory,
    });

    await expect(catalog.discoverServerTools("fortune")).rejects.toThrow(
      "offline",
    );
    await expect(catalog.discoverServerTools("fortune")).rejects.toThrow(
      "offline",
    );

    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });
});
