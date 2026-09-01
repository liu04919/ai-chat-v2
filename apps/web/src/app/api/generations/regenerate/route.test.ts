import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCurrentSession } from "@/lib/session";
import { getGenerationQueueProducer } from "@/server/generation-queue";
import {
  regenerateGenerationForOwner,
  RegenerationServiceError,
} from "@/server/generation-regeneration";

import { POST } from "./route";

vi.mock("@/lib/session", () => ({ getCurrentSession: vi.fn() }));
vi.mock("@/server/generation-queue", () => ({
  getGenerationQueueProducer: vi.fn(),
}));
vi.mock("@/server/generation-regeneration", () => {
  class MockRegenerationServiceError extends Error {
    constructor(
      readonly response: { code: string },
      readonly status: number,
    ) {
      super(response.code);
    }
  }

  return {
    regenerateGenerationForOwner: vi.fn(),
    RegenerationServiceError: MockRegenerationServiceError,
  };
});

const getSessionMock = vi.mocked(getCurrentSession);
const getQueueMock = vi.mocked(getGenerationQueueProducer);
const regenerateMock = vi.mocked(regenerateGenerationForOwner);
const requestBody = {
  conversationId: "conversation_123",
  assistantMessageId: "assistant_123",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Generation regenerate route", () => {
  it("未登录时返回 401", async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await POST(
      new Request("http://localhost/api/generations/regenerate", {
        method: "POST",
        body: JSON.stringify(requestBody),
      }),
    );

    expect(response.status).toBe(401);
    expect(regenerateMock).not.toHaveBeenCalled();
  });

  it("拒绝带额外控制字段的请求", async () => {
    getSessionMock.mockResolvedValue({
      session: {} as never,
      user: { id: "owner_123" } as never,
    });

    const response = await POST(
      new Request("http://localhost/api/generations/regenerate", {
        method: "POST",
        body: JSON.stringify({ ...requestBody, reasoningEffort: "high" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(regenerateMock).not.toHaveBeenCalled();
  });

  it("把当前用户、目标回答与队列交给重新生成服务", async () => {
    const queue = {} as ReturnType<typeof getGenerationQueueProducer>;
    getSessionMock.mockResolvedValue({
      session: {} as never,
      user: { id: "owner_123" } as never,
    });
    getQueueMock.mockReturnValue(queue);
    regenerateMock.mockResolvedValue({
      conversationId: requestBody.conversationId,
      generation: {
        id: "generation_123",
        userMessageId: "user_123",
        status: "queued",
        reasoningEffort: "medium",
        createdAt: "2026-09-01T12:00:00.000Z",
      },
    });

    const response = await POST(
      new Request("http://localhost/api/generations/regenerate", {
        method: "POST",
        body: JSON.stringify(requestBody),
      }),
    );

    expect(regenerateMock).toHaveBeenCalledWith(
      "owner_123",
      requestBody,
      { queue },
    );
    expect(response.status).toBe(201);
  });

  it("稳定映射服务错误", async () => {
    getSessionMock.mockResolvedValue({
      session: {} as never,
      user: { id: "owner_123" } as never,
    });
    getQueueMock.mockReturnValue({} as never);
    regenerateMock.mockRejectedValue(
      new RegenerationServiceError({ code: "REGENERATION_NOT_ALLOWED" }, 409),
    );

    const response = await POST(
      new Request("http://localhost/api/generations/regenerate", {
        method: "POST",
        body: JSON.stringify(requestBody),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "REGENERATION_NOT_ALLOWED",
    });
  });
});
