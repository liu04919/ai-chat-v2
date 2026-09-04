import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "./client";
import {
  createConversationShareRecordForOwner,
  deleteConversationShareRecordForOwner,
  getConversationShareAttachmentRecord,
  getConversationShareRecordByToken,
  getConversationShareRecordForOwner,
} from "./conversation-shares";
import { migrateDatabase } from "./migration";
import {
  attachments,
  conversations,
  generations,
  messages,
  user,
} from "./schema/index";
import { loadIntegrationTestEnvironment } from "./test-environment";

const testDatabaseUrl = loadIntegrationTestEnvironment();
const database = createDatabase(testDatabaseUrl, 1);
const ownerId = `share-owner-${randomUUID()}`;
const otherOwnerId = `share-other-${randomUUID()}`;

beforeAll(async () => {
  await migrateDatabase({
    databaseUrl: testDatabaseUrl,
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  await database.db.insert(user).values([
    {
      id: ownerId,
      name: "Share Owner",
      email: `${ownerId}@example.com`,
    },
    {
      id: otherOwnerId,
      name: "Share Other",
      email: `${otherOwnerId}@example.com`,
    },
  ]);
});

afterAll(async () => {
  await database.db.delete(user).where(eq(user.id, ownerId));
  await database.db.delete(user).where(eq(user.id, otherOwnerId));
  await database.close();
});

describe("Conversation Share persistence", () => {
  it("创建安全的不可变快照，并由 owner 停止分享", async () => {
    const conversationId = randomUUID();
    const attachmentId = randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const token = randomUUID();
    const createdAt = new Date("2026-09-03T10:00:00.000Z");
    await database.db.insert(conversations).values({
      id: conversationId,
      ownerId,
      mode: "chat",
      title: "快照标题",
      createdAt,
      updatedAt: createdAt,
    });
    await database.db.insert(attachments).values({
      id: attachmentId,
      ownerId,
      objectKey: `attachments/${attachmentId}`,
      originalName: "result.png",
      mediaType: "image/png",
      sizeBytes: 128,
      status: "ready",
      readyAt: createdAt,
      linkedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    });
    await database.db.insert(messages).values([
      {
        id: userMessageId,
        conversationId,
        role: "user",
        parts: [{ type: "text", text: "查询天气" }],
        sequence: 0,
        createdAt,
      },
      {
        id: assistantMessageId,
        conversationId,
        role: "assistant",
        parts: [
          { id: "reasoning-1", type: "reasoning", text: "先查询工具" },
          {
            id: "call-1",
            type: "tool-call",
            toolCallId: "tool-call-1",
            toolName: "weather",
            input: { city: "合肥" },
          },
          {
            id: "result-1",
            type: "tool-result",
            toolCallId: "tool-call-1",
            output: { temperature: 30 },
            isError: false,
          },
          { id: "text-1", type: "text", text: "今天 30℃" },
          { id: "image-1", type: "attachment", attachmentId },
        ],
        sequence: 1,
        createdAt,
      },
    ]);

    try {
      const created = await createConversationShareRecordForOwner(
        {
          id: randomUUID(),
          token,
          ownerId,
          conversationId,
          now: createdAt,
        },
        database.db,
      );
      expect(created.kind).toBe("created");
      if (created.kind !== "created") throw new Error("应创建分享");
      expect(created.share.title).toBe("快照标题");
      expect(created.share.snapshot.attachments).toEqual([
        {
          id: attachmentId,
          originalName: "result.png",
          mediaType: "image/png",
          sizeBytes: 128,
        },
      ]);
      const assistantParts = created.share.snapshot.messages[1]?.parts ?? [];
      expect(assistantParts.find((part) => part.type === "tool-call")).not.toHaveProperty("input");
      expect(assistantParts.find((part) => part.type === "tool-result")).not.toHaveProperty("output");

      await database.db.insert(messages).values({
        id: randomUUID(),
        conversationId,
        role: "user",
        parts: [{ type: "text", text: "分享后新增" }],
        sequence: 2,
      });
      await database.db
        .update(conversations)
        .set({ title: "新标题" })
        .where(eq(conversations.id, conversationId));
      const existing = await createConversationShareRecordForOwner(
        {
          id: randomUUID(),
          token: randomUUID(),
          ownerId,
          conversationId,
          now: new Date(),
        },
        database.db,
      );
      expect(existing.kind).toBe("existing");
      if (existing.kind !== "existing") throw new Error("应返回已有分享");
      expect(existing.share.token).toBe(token);
      expect(existing.share.title).toBe("快照标题");
      expect(existing.share.snapshot.messages).toHaveLength(2);

      await expect(
        getConversationShareRecordByToken(token, database.db),
      ).resolves.toMatchObject({ conversationId, token });
      await expect(
        getConversationShareAttachmentRecord(token, attachmentId, database.db),
      ).resolves.toMatchObject({ objectKey: `attachments/${attachmentId}` });
      await expect(
        getConversationShareRecordForOwner(otherOwnerId, conversationId, database.db),
      ).resolves.toEqual({ kind: "conversation_not_found" });
      await expect(
        deleteConversationShareRecordForOwner(otherOwnerId, conversationId, database.db),
      ).resolves.toBe(false);
      await expect(
        deleteConversationShareRecordForOwner(ownerId, conversationId, database.db),
      ).resolves.toBe(true);
      await expect(
        getConversationShareRecordByToken(token, database.db),
      ).resolves.toBeNull();
      await expect(
        getConversationShareAttachmentRecord(token, attachmentId, database.db),
      ).resolves.toBeNull();
    } finally {
      await database.db.delete(attachments).where(eq(attachments.id, attachmentId));
      await database.db.delete(conversations).where(eq(conversations.id, conversationId));
    }
  });

  it("存在 Active Generation 时拒绝制作快照", async () => {
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await database.db.insert(conversations).values({
      id: conversationId,
      ownerId,
      mode: "chat",
      title: "生成中",
    });
    await database.db.insert(messages).values({
      id: messageId,
      conversationId,
      role: "user",
      parts: [{ type: "text", text: "继续" }],
      sequence: 0,
    });
    await database.db.insert(generations).values({
      id: randomUUID(),
      conversationId,
      userMessageId: messageId,
      status: "running",
    });

    try {
      await expect(
        createConversationShareRecordForOwner(
          {
            id: randomUUID(),
            token: randomUUID(),
            ownerId,
            conversationId,
            now: new Date(),
          },
          database.db,
        ),
      ).resolves.toEqual({ kind: "active_generation" });
    } finally {
      await database.db.delete(conversations).where(eq(conversations.id, conversationId));
    }
  });
});
