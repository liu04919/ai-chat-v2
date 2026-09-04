import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCurrentSession } from "@/lib/session";
import {
  ConversationShareServiceError,
  createConversationShareForOwner,
  deleteConversationShareForOwner,
  getConversationShareForOwner,
} from "@/server/conversation-shares";
import { DELETE, GET, POST } from "./route";

vi.mock("@/lib/session", () => ({ getCurrentSession: vi.fn() }));
vi.mock("@/server/conversation-shares", () => ({
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
  vi.mocked(getCurrentSession).mockResolvedValue({
    user: { id: "owner-1" },
  } as Awaited<ReturnType<typeof getCurrentSession>>);
  vi.mocked(getConversationShareForOwner).mockResolvedValue({ share: null });
  vi.mocked(createConversationShareForOwner).mockResolvedValue(share);
  vi.mocked(deleteConversationShareForOwner).mockResolvedValue({
    conversationId: "conversation-1",
  });
});

describe("Conversation Share API", () => {
  it("未登录不能查询、创建或停止分享", async () => {
    vi.mocked(getCurrentSession).mockResolvedValue(null);

    expect((await GET(request, context)).status).toBe(401);
    expect((await POST(request, context)).status).toBe(401);
    expect((await DELETE(request, context)).status).toBe(401);
    expect(getConversationShareForOwner).not.toHaveBeenCalled();
  });

  it("查询当前状态时限定 owner 并使用请求 origin", async () => {
    const response = await GET(request, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ share: null });
    expect(getConversationShareForOwner).toHaveBeenCalledWith(
      "owner-1",
      "conversation-1",
      "https://chat.example.com",
    );
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
