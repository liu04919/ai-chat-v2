import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConversationShareClientError,
  createConversationShare,
  deleteConversationShare,
  fetchConversationShare,
} from "./conversation-shares-client";

const share = {
  conversationId: "conversation-1",
  url: "https://chat.example.com/share/0c056b9d-2c12-4ccb-a5f2-6d996eceef59",
  createdAt: "2026-09-03T10:00:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("Conversation Share client", () => {
  it("查询、创建和停止使用同一个会话级端点", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ share: null }))
      .mockResolvedValueOnce(Response.json(share, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ conversationId: "conversation-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchConversationShare("conversation-1")).resolves.toEqual({
      share: null,
    });
    await expect(createConversationShare("conversation-1")).resolves.toEqual(
      share,
    );
    await expect(deleteConversationShare("conversation-1")).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual([
      "GET",
      "POST",
      "DELETE",
    ]);
  });

  it("把生成中错误转换成可显示的提示", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ code: "ACTIVE_GENERATION" }, { status: 409 }),
      ),
    );

    await expect(createConversationShare("conversation-1")).rejects.toEqual(
      expect.objectContaining<Partial<ConversationShareClientError>>({
        code: "ACTIVE_GENERATION",
        message: "请等待本轮回复结束后再分享",
      }),
    );
  });
});
