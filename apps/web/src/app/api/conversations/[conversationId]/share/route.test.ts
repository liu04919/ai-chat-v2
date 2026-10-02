import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getCurrentSession } from "@/server/auth/session";
import {
  ConversationShareServiceError,
  createConversationShareForOwner,
  deleteConversationShareForOwner,
  getConversationShareForOwner,
} from "@/server/conversations/shares";
import { DELETE, GET, POST } from "./route";

vi.mock("@/server/auth/session", () => ({ getCurrentSession: vi.fn() }));
vi.mock("@/server/conversations/shares", () => ({
  ConversationShareServiceError: class ConversationShareServiceError extends Error {
    constructor(
      readonly code:
        | "CONVERSATION_NOT_FOUND"
        | "ACTIVE_GENERATION"
        | "EMPTY_CONVERSATION",
      readonly status: 404 | 409,
    ) {
      super(code);
    }
  },
  createConversationShareForOwner: vi.fn(),
  deleteConversationShareForOwner: vi.fn(),
  getConversationShareForOwner: vi.fn(),
}));

const context = { params: Promise.resolve({ conversationId: "conversation-1" }) };
const request = new Request("https://chat.example.com/api/conversations/conversation-1/share");
const share = {
  conversationId: "conversation-1",
  url: "https://chat.example.com/share/0c056b9d-2c12-4ccb-a5f2-6d996eceef59",
  createdAt: "2026-09-03T10:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BETTER_AUTH_URL", "https://chat.example.com");
  vi.mocked(getCurrentSession).mockResolvedValue({
    user: { id: "owner-1" },
  } as Awaited<ReturnType<typeof getCurrentSession>>);
  vi.mocked(getConversationShareForOwner).mockResolvedValue({ share: null });
  vi.mocked(createConversationShareForOwner).mockResolvedValue(share);
  vi.mocked(deleteConversationShareForOwner).mockResolvedValue({
    conversationId: "conversation-1",
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("Conversation Share API", () => {
  it("未登录不能查询、创建或停止分享", async () => {
    vi.mocked(getCurrentSession).mockResolvedValue(null);
    vi.stubEnv("BETTER_AUTH_URL", undefined);

    expect((await GET(request, context)).status).toBe(401);
    expect((await POST(request, context)).status).toBe(401);
    expect((await DELETE(request, context)).status).toBe(401);
    expect(getConversationShareForOwner).not.toHaveBeenCalled();
  });

  it("查询当前状态时限定 owner 并使用配置的站点 origin", async () => {
    const response = await GET(request, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ share: null });
    expect(getConversationShareForOwner).toHaveBeenCalledWith(
      "owner-1",
      "conversation-1",
      "https://chat.example.com",
    );
  });

  it.each([
    "http://localhost:3000",
    "http://localhost:3001",
    "https://chat.example.com",
  ])("容器内部请求的查询和创建都使用外部地址 %s", async (origin) => {
    vi.stubEnv("BETTER_AUTH_URL", `${origin}/`);
    const internalRequest = new Request(
      "http://0.0.0.0:3000/api/conversations/conversation-1/share",
      { headers: { "X-Forwarded-Host": "untrusted.example.com" } },
    );

    expect((await GET(internalRequest, context)).status).toBe(200);
    expect((await POST(internalRequest, context)).status).toBe(201);
    for (const service of [getConversationShareForOwner, createConversationShareForOwner]) {
      expect(service).toHaveBeenCalledWith("owner-1", "conversation-1", origin);
    }
  });

  it.each([undefined, ""])("站点地址缺失（%s）时明确报错，不回退到请求地址", async (value) => {
    vi.stubEnv("BETTER_AUTH_URL", value);

    await expect(GET(request, context)).rejects.toThrow("缺少 BETTER_AUTH_URL");
    await expect(POST(request, context)).rejects.toThrow("缺少 BETTER_AUTH_URL");
    expect(getConversationShareForOwner).not.toHaveBeenCalled();
    expect(createConversationShareForOwner).not.toHaveBeenCalled();
  });

  it("停止分享不依赖站点地址配置", async () => {
    vi.stubEnv("BETTER_AUTH_URL", undefined);

    expect((await DELETE(request, context)).status).toBe(200);
    expect(deleteConversationShareForOwner).toHaveBeenCalledWith("owner-1", "conversation-1");
  });

  it("创建返回 201，停止分享返回 Conversation ID", async () => {
    const created = await POST(request, context);
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toEqual(share);

    const deleted = await DELETE(request, context);
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({
      conversationId: "conversation-1",
    });
  });

  it("生成中创建分享返回 409", async () => {
    vi.mocked(createConversationShareForOwner).mockRejectedValue(
      new ConversationShareServiceError("ACTIVE_GENERATION", 409),
    );

    const response = await POST(request, context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "ACTIVE_GENERATION",
    });
  });
});
