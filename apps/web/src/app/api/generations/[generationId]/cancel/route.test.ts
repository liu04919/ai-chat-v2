import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCurrentSession } from "@/lib/session";
import {
  cancelGenerationForOwner,
  GenerationCancellationServiceError,
} from "@/server/generation-cancellation";
import { getGenerationCancellationInfrastructure } from "@/server/generation-cancellation-infrastructure";

import { POST } from "./route";

vi.mock("@/lib/session", () => ({ getCurrentSession: vi.fn() }));
vi.mock("@/server/generation-cancellation", () => {
  class MockGenerationCancellationServiceError extends Error {
    constructor(
      readonly response: { code: string },
      readonly status: number,
    ) {
      super(response.code);
    }
  }

  return {
    cancelGenerationForOwner: vi.fn(),
    GenerationCancellationServiceError:
      MockGenerationCancellationServiceError,
  };
});
vi.mock("@/server/generation-cancellation-infrastructure", () => ({
  getGenerationCancellationInfrastructure: vi.fn(),
}));

const getSessionMock = vi.mocked(getCurrentSession);
const cancelGenerationMock = vi.mocked(cancelGenerationForOwner);
const getInfrastructureMock = vi.mocked(
  getGenerationCancellationInfrastructure,
);
const context = {
  params: Promise.resolve({ generationId: "generation_123" }),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Generation cancel route", () => {
  it("未登录时返回 401", async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await POST(
      new Request("http://localhost/api/generations/generation_123/cancel", {
        method: "POST",
      }),
      context,
    );

    expect(response.status).toBe(401);
    expect(cancelGenerationMock).not.toHaveBeenCalled();
  });

  it("把当前用户和 generationId 交给取消服务", async () => {
    const infrastructure = {} as ReturnType<
      typeof getGenerationCancellationInfrastructure
    >;
    getSessionMock.mockResolvedValue({
      session: {} as never,
      user: { id: "owner_123" } as never,
    });
    getInfrastructureMock.mockReturnValue(infrastructure);
    cancelGenerationMock.mockResolvedValue({
      generation: {
        id: "generation_123",
        status: "running",
        cancelRequestedAt: "2026-08-30T10:00:00.000Z",
      },
    });

    const response = await POST(
      new Request("http://localhost/api/generations/generation_123/cancel", {
        method: "POST",
      }),
      context,
    );

    expect(cancelGenerationMock).toHaveBeenCalledWith(
      "owner_123",
      "generation_123",
      infrastructure,
    );
    expect(response.status).toBe(200);
  });

  it("稳定映射服务错误", async () => {
    getSessionMock.mockResolvedValue({
      session: {} as never,
      user: { id: "owner_123" } as never,
    });
    getInfrastructureMock.mockReturnValue({} as never);
    cancelGenerationMock.mockRejectedValue(
      new GenerationCancellationServiceError(
        { code: "GENERATION_NOT_FOUND" },
        404,
      ),
    );

    const response = await POST(
      new Request("http://localhost/api/generations/missing/cancel", {
        method: "POST",
      }),
      { params: Promise.resolve({ generationId: "missing" }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "GENERATION_NOT_FOUND",
    });
  });
});
