import {
  getMcpToolPreferencesForUser,
  saveMcpToolPreferencesForUser,
} from "@ai-chat/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCurrentSession } from "@/lib/session";

import { GET, PUT } from "./route";

vi.mock("@/lib/session", () => ({ getCurrentSession: vi.fn() }));
vi.mock("@ai-chat/db", () => ({
  getMcpToolPreferencesForUser: vi.fn(),
  saveMcpToolPreferencesForUser: vi.fn(),
}));

const getSessionMock = vi.mocked(getCurrentSession);
const getPreferencesMock = vi.mocked(getMcpToolPreferencesForUser);
const savePreferencesMock = vi.mocked(saveMcpToolPreferencesForUser);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MCP Tool preferences route", () => {
  it("未登录时拒绝读取和写入", async () => {
    getSessionMock.mockResolvedValue(null);

    expect((await GET()).status).toBe(401);
    expect(
      (
        await PUT(
          new Request("http://localhost/api/tools/mcp/preferences", {
            method: "PUT",
            body: JSON.stringify({ mcpToolIds: [] }),
          }),
        )
      ).status,
    ).toBe(401);
    expect(getPreferencesMock).not.toHaveBeenCalled();
    expect(savePreferencesMock).not.toHaveBeenCalled();
  });

  it("读取当前用户的启用配置", async () => {
    getSessionMock.mockResolvedValue({
      session: {} as never,
      user: { id: "owner_123" } as never,
    });
    getPreferencesMock.mockResolvedValue({
      mcpToolIds: ["fortune.draw_tarot_reading"],
    });

    const response = await GET();

    expect(getPreferencesMock).toHaveBeenCalledWith("owner_123");
    await expect(response.json()).resolves.toEqual({
      mcpToolIds: ["fortune.draw_tarot_reading"],
    });
  });

  it("校验、排序并保存具体 Tool ID", async () => {
    getSessionMock.mockResolvedValue({
      session: {} as never,
      user: { id: "owner_123" } as never,
    });
    savePreferencesMock.mockResolvedValue({
      mcpToolIds: [
        "baidu-maps.map_weather",
        "fortune.draw_tarot_reading",
      ],
    });

    const response = await PUT(
      new Request("http://localhost/api/tools/mcp/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mcpToolIds: [
            "fortune.draw_tarot_reading",
            "baidu-maps.map_weather",
          ],
        }),
      }),
    );

    expect(savePreferencesMock).toHaveBeenCalledWith("owner_123", [
      "baidu-maps.map_weather",
      "fortune.draw_tarot_reading",
    ]);
    expect(response.status).toBe(200);
  });

  it("拒绝非法或重复的 Tool ID", async () => {
    getSessionMock.mockResolvedValue({
      session: {} as never,
      user: { id: "owner_123" } as never,
    });

    const response = await PUT(
      new Request("http://localhost/api/tools/mcp/preferences", {
        method: "PUT",
        body: JSON.stringify({ mcpToolIds: ["invalid"] }),
      }),
    );

    expect(response.status).toBe(400);
    expect(savePreferencesMock).not.toHaveBeenCalled();
  });
});
