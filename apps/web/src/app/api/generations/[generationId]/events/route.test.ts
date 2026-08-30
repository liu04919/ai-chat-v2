import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCurrentSession } from "@/lib/session";
import { openGenerationEventStreamForOwner } from "@/server/generation-event-stream";

import { GET } from "./route";

vi.mock("@/lib/session", () => ({
  getCurrentSession: vi.fn(),
}));
vi.mock("@/server/generation-event-stream", () => ({
  openGenerationEventStreamForOwner: vi.fn(),
}));

const getSessionMock = vi.mocked(getCurrentSession);
const openStreamMock = vi.mocked(openGenerationEventStreamForOwner);
const routeContext = {
  params: Promise.resolve({ generationId: "generation_123" }),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Generation events route", () => {
  it("未登录时返回 401", async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await GET(
      new Request("http://localhost/api/generations/generation_123/events"),
      routeContext,
    );

    expect(response.status).toBe(401);
    expect(openStreamMock).not.toHaveBeenCalled();
  });

  it("拒绝非法 Last-Event-ID", async () => {
    getSessionMock.mockResolvedValue({
      session: {} as never,
      user: { id: "owner_123" } as never,
    });

    const response = await GET(
      new Request("http://localhost/api/generations/generation_123/events", {
        headers: { "Last-Event-ID": "invalid" },
      }),
      routeContext,
    );

    expect(response.status).toBe(400);
    expect(openStreamMock).not.toHaveBeenCalled();
  });

  it("把合法 cursor 和当前用户交给 SSE 服务", async () => {
    getSessionMock.mockResolvedValue({
      session: {} as never,
      user: { id: "owner_123" } as never,
    });
    openStreamMock.mockResolvedValue(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
    );

    const response = await GET(
      new Request("http://localhost/api/generations/generation_123/events", {
        headers: { "Last-Event-ID": "123-0" },
      }),
      routeContext,
    );

    expect(openStreamMock).toHaveBeenCalledWith(
      "owner_123",
      "generation_123",
      "123-0",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-transform",
    );
  });

  it("对不存在或不属于当前用户的 Generation 返回 404", async () => {
    getSessionMock.mockResolvedValue({
      session: {} as never,
      user: { id: "owner_123" } as never,
    });
    openStreamMock.mockResolvedValue(null);

    const response = await GET(
      new Request("http://localhost/api/generations/generation_123/events"),
      routeContext,
    );

    expect(response.status).toBe(404);
  });
});
