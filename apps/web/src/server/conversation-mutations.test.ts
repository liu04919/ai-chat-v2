import {
  deleteConversationRecordForOwner,
  setConversationPinnedForOwner,
} from "@ai-chat/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConversationMutationError,
  deleteConversationForOwner,
  pinConversationForOwner,
} from "./conversation-mutations";

vi.mock("@ai-chat/db", () => ({
  deleteConversationRecordForOwner: vi.fn(),
  setConversationPinnedForOwner: vi.fn(),
}));
vi.mock("./attachment-storage", () => ({
  getAttachmentObjectStorage: vi.fn(),
}));
vi.mock("./generation-cancellation-infrastructure", () => ({
  getGenerationCancellationInfrastructure: vi.fn(),
}));

const deleteRecord = vi.mocked(deleteConversationRecordForOwner);
const setPinned = vi.mocked(setConversationPinnedForOwner);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Conversation mutation services", () => {
  it("返回置顶后的安全 Conversation DTO", async () => {
    const now = new Date("2026-09-03T10:00:00.000Z");
    setPinned.mockResolvedValue({
      id: "c1",
      mode: "chat",
      title: "测试",
      pinnedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await expect(pinConversationForOwner("owner", "c1", true, now)).resolves.toEqual({
      id: "c1",
      mode: "chat",
      title: "测试",
      pinnedAt: now.toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  });

  it("删除后只通知 running Generation，并清理所有附件对象", async () => {
    const publish = vi.fn(async () => undefined);
    const deleteObject = vi.fn(async () => undefined);
    deleteRecord.mockResolvedValue({
      conversationId: "c1",
      activeGenerations: [
        { id: "queued", status: "queued" },
        { id: "running", status: "running" },
      ],
      attachmentObjectKeys: ["attachments/a", "attachments/b"],
    });

    await expect(
      deleteConversationForOwner("owner", "c1", {
        cancellationPublisher: { publish },
        storage: { deleteObject },
      }),
    ).resolves.toEqual({ conversationId: "c1" });
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith("running");
    expect(deleteObject).toHaveBeenCalledTimes(2);
  });

  it("不存在或不属于当前用户时统一表现为 404", async () => {
    setPinned.mockResolvedValue(null);
    deleteRecord.mockResolvedValue(null);

    await expect(pinConversationForOwner("owner", "missing", true)).rejects.toEqual(
      expect.objectContaining<Partial<ConversationMutationError>>({ status: 404 }),
    );
    await expect(
      deleteConversationForOwner("owner", "missing"),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ConversationMutationError>>({ status: 404 }),
    );
  });
});
