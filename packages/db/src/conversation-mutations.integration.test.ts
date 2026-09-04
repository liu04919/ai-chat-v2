import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "./client";
import {
  deleteConversationRecordForOwner,
  setConversationPinnedForOwner,
} from "./conversation-mutations";
import { listConversationRecordsForOwner } from "./conversation-reader";
import { migrateDatabase } from "./migration";
import {
  attachments,
  conversations,
  conversationShares,
  generations,
  messages,
  user,
} from "./schema/index";
import { loadIntegrationTestEnvironment } from "./test-environment";

const testDatabaseUrl = loadIntegrationTestEnvironment();
const database = createDatabase(testDatabaseUrl, 1);
const ownerId = `conversation-mutation-owner-${randomUUID()}`;
const otherOwnerId = `conversation-mutation-other-${randomUUID()}`;

beforeAll(async () => {
  await migrateDatabase({
    databaseUrl: testDatabaseUrl,
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  await database.db.insert(user).values([
    {
      id: ownerId,
      name: "Conversation Mutation Owner",
      email: `${ownerId}@example.com`,
    },
    {
      id: otherOwnerId,
      name: "Conversation Mutation Other",
      email: `${otherOwnerId}@example.com`,
    },
  ]);
});

afterAll(async () => {
  await database.db.delete(user).where(eq(user.id, ownerId));
  await database.db.delete(user).where(eq(user.id, otherOwnerId));
  await database.close();
});

describe("Conversation mutations", () => {
  it("按置顶时间排序，且置顶操作不改变会话活跃时间", async () => {
    const olderId = randomUUID();
    const newerId = randomUUID();
    const olderUpdatedAt = new Date("2026-08-01T00:00:00.000Z");
    const pinnedAt = new Date("2026-09-03T10:00:00.000Z");
    await database.db.insert(conversations).values([
      {
        id: olderId,
        ownerId,
        mode: "chat",
        title: "较早但置顶",
        createdAt: olderUpdatedAt,
        updatedAt: olderUpdatedAt,
      },
      {
        id: newerId,
        ownerId,
        mode: "chat",
        title: "最近会话",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
        updatedAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    ]);

    try {
      const pinned = await setConversationPinnedForOwner(
        { ownerId, conversationId: olderId, pinned: true, now: pinnedAt },
        database.db,
      );
      expect(pinned?.pinnedAt).toEqual(pinnedAt);
      expect(pinned?.updatedAt).toEqual(olderUpdatedAt);
      expect(
        (await listConversationRecordsForOwner(ownerId, database.db)).map(
          (conversation) => conversation.id,
        ),
      ).toEqual([olderId, newerId]);

      const unpinned = await setConversationPinnedForOwner(
        { ownerId, conversationId: olderId, pinned: false, now: pinnedAt },
        database.db,
      );
      expect(unpinned?.pinnedAt).toBeNull();
      expect(
        (await listConversationRecordsForOwner(ownerId, database.db)).map(
          (conversation) => conversation.id,
        ),
      ).toEqual([newerId, olderId]);
    } finally {
      await database.db
        .delete(conversations)
        .where(eq(conversations.id, olderId));
      await database.db
        .delete(conversations)
        .where(eq(conversations.id, newerId));
    }
  });

  it("其他用户不能置顶或删除不属于自己的会话", async () => {
    const conversationId = randomUUID();
    await database.db.insert(conversations).values({
      id: conversationId,
      ownerId: otherOwnerId,
      mode: "chat",
      title: "私有会话",
    });

    try {
      await expect(
        setConversationPinnedForOwner(
          { ownerId, conversationId, pinned: true, now: new Date() },
          database.db,
        ),
      ).resolves.toBeNull();
      await expect(
        deleteConversationRecordForOwner(
          ownerId,
          conversationId,
          database.db,
        ),
      ).resolves.toBeNull();
      await expect(
        database.db.query.conversations.findFirst({
          where: eq(conversations.id, conversationId),
        }),
      ).resolves.toBeDefined();
    } finally {
      await database.db
        .delete(conversations)
        .where(eq(conversations.id, conversationId));
    }
  });

  it("删除会话会级联消息和 Generation，并返回需要清理的附件与运行任务", async () => {
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const generationId = randomUUID();
    const attachmentId = randomUUID();
    const objectKey = `attachments/${attachmentId}`;
    await database.db.insert(conversations).values({
      id: conversationId,
      ownerId,
      mode: "image",
      title: "待删除会话",
    });
    await database.db.insert(attachments).values({
      id: attachmentId,
      ownerId,
      objectKey,
      originalName: "result.png",
      mediaType: "image/png",
      sizeBytes: 128,
      status: "ready",
      readyAt: new Date(),
      linkedAt: new Date(),
    });
    await database.db.insert(messages).values({
      id: messageId,
      conversationId,
      role: "user",
      parts: [
        { type: "text", text: "生成图片" },
        { type: "attachment", attachmentId },
      ],
      sequence: 0,
    });
    await database.db.insert(generations).values({
      id: generationId,
      conversationId,
      userMessageId: messageId,
      status: "running",
    });

    await expect(
      deleteConversationRecordForOwner(ownerId, conversationId, database.db),
    ).resolves.toEqual({
      conversationId,
      activeGenerations: [{ id: generationId, status: "running" }],
      attachmentObjectKeys: [objectKey],
    });
    await expect(
      database.db.query.conversations.findFirst({
        where: eq(conversations.id, conversationId),
      }),
    ).resolves.toBeUndefined();
    await expect(
      database.db.query.messages.findFirst({
        where: eq(messages.id, messageId),
      }),
    ).resolves.toBeUndefined();
    await expect(
      database.db.query.generations.findFirst({
        where: eq(generations.id, generationId),
      }),
    ).resolves.toBeUndefined();
    await expect(
      database.db.query.attachments.findFirst({
        where: eq(attachments.id, attachmentId),
      }),
    ).resolves.toBeUndefined();
  });

  it("删除会话也会清理只被不可变分享快照引用的附件", async () => {
    const conversationId = randomUUID();
    const attachmentId = randomUUID();
    const objectKey = `attachments/${attachmentId}`;
    const now = new Date();
    await database.db.insert(conversations).values({
      id: conversationId,
      ownerId,
      mode: "image",
      title: "已有分享的会话",
    });
    await database.db.insert(attachments).values({
      id: attachmentId,
      ownerId,
      objectKey,
      originalName: "old-result.png",
      mediaType: "image/png",
      sizeBytes: 128,
      status: "ready",
      readyAt: now,
      linkedAt: now,
    });
    await database.db.insert(conversationShares).values({
      id: randomUUID(),
      conversationId,
      token: randomUUID(),
      title: "旧快照",
      snapshot: {
        version: 1,
        messages: [
          {
            id: randomUUID(),
            role: "user",
            sequence: 0,
            parts: [{ type: "text", text: "生成旧图片" }],
            createdAt: now.toISOString(),
          },
        ],
        attachments: [
          {
            id: attachmentId,
            originalName: "old-result.png",
            mediaType: "image/png",
            sizeBytes: 128,
          },
        ],
      },
    });

    await expect(
      deleteConversationRecordForOwner(ownerId, conversationId, database.db),
    ).resolves.toEqual({
      conversationId,
      activeGenerations: [],
      attachmentObjectKeys: [objectKey],
    });
    await expect(
      database.db.query.attachments.findFirst({
        where: eq(attachments.id, attachmentId),
      }),
    ).resolves.toBeUndefined();
  });
});
