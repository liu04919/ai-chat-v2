import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCurrentSession } from "@/lib/session";
import {
  ConversationMutationError,
  pinConversationForOwner,
} from "@/server/conversation-mutations";
import { DELETE, PUT } from "./route";

vi.mock("@/lib/session", () => ({ getCurrentSession: vi.fn() }));
vi.mock("@/server/conversation-mutations", () => ({
  ConversationMutationError: class ConversationMutationError extends Error {
    constructor(readonly status: 404) {
      super("CONVERSATION_NOT_FOUND");
    }
  },
  pinConversationForOwner: vi.fn(),
}));

const context = { params: Promise.resolve({ conversationId: "c1" }) };
const now = "2026-09-03T10:00:00.000Z";
const conversation = {
  id: "c1",
  mode: "chat" as const,
  title: "测试会话",
  pinnedAt: now,
  createdAt: now,
  updatedAt: now,
};
const getSession = vi.mocked(getCurrentSession);
const pinConversation = vi.mocked(pinConversationForOwner);

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: "owner" } } as Awaited<
    ReturnType<typeof getCurrentSession>
  >);
  pinConversation.mockResolvedValue(conversation);
});

describe("会话置顶 API", () => {
  it("未登录不修改置顶状态", async () => {
    getSession.mockResolvedValue(null);

    expect((await PUT(new Request("http://localhost"), context)).status).toBe(401);
    expect(pinConversation).not.toHaveBeenCalled();
  });

  it("PUT 置顶，DELETE 取消置顶", async () => {
    const pinnedResponse = await PUT(new Request("http://localhost"), context);
    expect(pinnedResponse.status).toBe(200);
    expect(pinConversation).toHaveBeenNthCalledWith(1, "owner", "c1", true);

    pinConversation.mockResolvedValue({ ...conversation, pinnedAt: null });
    const unpinnedResponse = await DELETE(
      new Request("http://localhost"),
      context,
    );
    expect(unpinnedResponse.status).toBe(200);
    expect(pinConversation).toHaveBeenNthCalledWith(2, "owner", "c1", false);
  });

  it("不存在或不属于当前用户时返回 404", async () => {
    pinConversation.mockRejectedValue(new ConversationMutationError(404));

    const response = await PUT(new Request("http://localhost"), context);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "CONVERSATION_NOT_FOUND",
    });
  });
});
