import {
  createConversationShareRecordForOwner,
  deleteConversationShareRecordForOwner,
  getConversationShareAttachmentRecord,
  getConversationShareRecordForOwner,
} from "@ai-chat/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConversationShareServiceError,
  createConversationShareForOwner,
  deleteConversationShareForOwner,
  getConversationShareForOwner,
  readPublicConversationShareAttachment,
} from "./conversation-shares";

vi.mock("@ai-chat/db", () => ({
  createConversationShareRecordForOwner: vi.fn(),
  deleteConversationShareRecordForOwner: vi.fn(),
  getConversationShareAttachmentRecord: vi.fn(),
  getConversationShareRecordByToken: vi.fn(),
  getConversationShareRecordForOwner: vi.fn(),
}));

const now = new Date("2026-09-03T10:00:00.000Z");
const shareRecord = {
  id: "share-1",
  conversationId: "conversation-1",
  token: "0c056b9d-2c12-4ccb-a5f2-6d996eceef59",
  title: "测试会话",
  snapshot: {
    version: 1 as const,
    messages: [
      {
        id: "message-1",
        role: "user" as const,
        sequence: 0,
        parts: [{ type: "text" as const, text: "你好" }],
        createdAt: now.toISOString(),
      },
    ],
    attachments: [],
  },
  createdAt: now,
};

beforeEach(() => vi.clearAllMocks());

describe("Conversation Share services", () => {
  it("查询和创建只返回公开 URL，不返回快照正文", async () => {
    vi.mocked(getConversationShareRecordForOwner).mockResolvedValue({
      kind: "found",
      share: shareRecord,
    });
    vi.mocked(createConversationShareRecordForOwner).mockResolvedValue({
      kind: "created",
      share: shareRecord,
    });

    await expect(
      getConversationShareForOwner(
        "owner-1",
        "conversation-1",
        "https://chat.example.com",
      ),
    ).resolves.toEqual({
      share: {
        conversationId: "conversation-1",
        url: `https://chat.example.com/share/${shareRecord.token}`,
        createdAt: now.toISOString(),
      },
    });
    await expect(
      createConversationShareForOwner(
        "owner-1",
        "conversation-1",
        "https://chat.example.com",
      ),
    ).resolves.not.toHaveProperty("snapshot");
  });

  it("把 active 和空会话映射为明确的 409", async () => {
    vi.mocked(createConversationShareRecordForOwner)
      .mockResolvedValueOnce({ kind: "active_generation" })
      .mockResolvedValueOnce({ kind: "empty_conversation" });

    await expect(
      createConversationShareForOwner("owner", "conversation", "https://chat.example.com"),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ConversationShareServiceError>>({
        code: "ACTIVE_GENERATION",
        status: 409,
      }),
    );
    await expect(
      createConversationShareForOwner("owner", "conversation", "https://chat.example.com"),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ConversationShareServiceError>>({
        code: "EMPTY_CONVERSATION",
        status: 409,
      }),
    );
  });

  it("停止分享必须通过 owner 检查", async () => {
    vi.mocked(deleteConversationShareRecordForOwner).mockResolvedValue(false);

    await expect(
      deleteConversationShareForOwner("other", "conversation-1"),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ConversationShareServiceError>>({
        code: "CONVERSATION_NOT_FOUND",
        status: 404,
      }),
    );
  });

  it("公开附件先验证快照引用，再读取对象", async () => {
    vi.mocked(getConversationShareAttachmentRecord).mockResolvedValue({
      objectKey: "attachments/image-1",
      originalName: "image.png",
      mediaType: "image/png",
    });
    const readObject = vi.fn(async () => new Uint8Array([1, 2, 3]));

    await expect(
      readPublicConversationShareAttachment("token", "image-1", {
        storage: { readObject },
      }),
    ).resolves.toMatchObject({
      objectKey: "attachments/image-1",
      data: new Uint8Array([1, 2, 3]),
    });
    expect(readObject).toHaveBeenCalledWith("attachments/image-1");
  });
});
