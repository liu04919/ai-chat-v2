import {
  deleteConversationRecordForOwner,
  setConversationPinnedForOwner,
} from "@ai-chat/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getObjectStorage } from "../object-storage";
import { getGenerationCancellationInfrastructure } from "../generations/cancellation-infrastructure";

import {
  ConversationMutationError,
  deleteConversationForOwner,
  pinConversationForOwner,
} from "./mutations";

vi.mock("@ai-chat/db", () => ({
  deleteConversationRecordForOwner: vi.fn(),
  setConversationPinnedForOwner: vi.fn(),
}));
vi.mock("../object-storage", () => ({
  getObjectStorage: vi.fn(),
}));
vi.mock("../generations/cancellation-infrastructure", () => ({
  getGenerationCancellationInfrastructure: vi.fn(),
}));

const deleteRecord = vi.mocked(deleteConversationRecordForOwner);
const setPinned = vi.mocked(setConversationPinnedForOwner);

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

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

  it("R2 初始化失败不改变已删除结果，也不妨碍通知 Worker", async () => {
    const failure = new Error("R2 configuration missing");
    vi.mocked(getObjectStorage).mockImplementation(() => { throw failure; });
    const publish = vi.fn(async () => undefined);
    deleteRecord.mockResolvedValue({
      conversationId: "c1",
      activeGenerations: [{ id: "running", status: "running" }],
      attachmentObjectKeys: ["attachments/a"],
    });

    await expect(deleteConversationForOwner("owner", "c1", {
      cancellationPublisher: { publish },
    })).resolves.toEqual({ conversationId: "c1" });
    expect(publish).toHaveBeenCalledWith("running");
    expect(console.error).toHaveBeenCalledWith("删除 Conversation 后清理外部资源失败", failure);
  });

  it("取消通知初始化失败仍清理附件并返回删除成功", async () => {
    const failure = new Error("Redis configuration missing");
    vi.mocked(getGenerationCancellationInfrastructure).mockImplementation(() => { throw failure; });
    const deleteObject = vi.fn(async () => undefined);
    deleteRecord.mockResolvedValue({
      conversationId: "c1",
      activeGenerations: [{ id: "running", status: "running" }],
      attachmentObjectKeys: ["attachments/a", "attachments/b"],
    });

    await expect(deleteConversationForOwner("owner", "c1", {
      storage: { deleteObject },
    })).resolves.toEqual({ conversationId: "c1" });
    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith("删除 Conversation 后清理外部资源失败", failure);
  });

  it("清理的同步异常和异步失败都被隔离，其余对象继续清理", async () => {
    const publish = vi.fn().mockRejectedValue(new Error("publish failed"));
    const deleteObject = vi.fn((key: string) => {
      if (key === "attachments/a") throw new Error("synchronous cleanup failure");
      return Promise.resolve();
    });
    deleteRecord.mockResolvedValue({
      conversationId: "c1",
      activeGenerations: [{ id: "running", status: "running" }],
      attachmentObjectKeys: ["attachments/a", "attachments/b"],
    });

    await expect(deleteConversationForOwner("owner", "c1", {
      cancellationPublisher: { publish }, storage: { deleteObject },
    })).resolves.toEqual({ conversationId: "c1" });
    expect(deleteObject).toHaveBeenCalledWith("attachments/b");
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it("没有运行任务或附件时不初始化清理依赖", async () => {
    deleteRecord.mockResolvedValue({
      conversationId: "c1", activeGenerations: [], attachmentObjectKeys: [],
    });
    await expect(deleteConversationForOwner("owner", "c1")).resolves.toEqual({ conversationId: "c1" });
    expect(getObjectStorage).not.toHaveBeenCalled();
    expect(getGenerationCancellationInfrastructure).not.toHaveBeenCalled();
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
