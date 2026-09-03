import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "./client";
import { migrateDatabase } from "./migration";
import {
  attachments,
  conversations,
  generations,
  messages,
  user,
  userToolPreferences,
} from "./schema/index";
import { loadIntegrationTestEnvironment } from "./test-environment";

const testDatabaseUrl = loadIntegrationTestEnvironment();
const database = createDatabase(testDatabaseUrl, 1);
const ownerId = `db-test-user-${randomUUID()}`;
const conversationId = `db-test-conversation-${randomUUID()}`;
const userMessageId = `db-test-message-${randomUUID()}`;

beforeAll(async () => {
  await migrateDatabase({
    databaseUrl: testDatabaseUrl,
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });

  await database.db.insert(user).values({
    id: ownerId,
    name: "数据库约束测试用户",
    email: `${ownerId}@example.com`,
  });
  await database.db.insert(conversations).values({
    id: conversationId,
    ownerId,
    mode: "chat",
    title: "数据库约束测试会话",
  });
  await database.db.insert(messages).values({
    id: userMessageId,
    conversationId,
    role: "user",
    parts: [{ type: "text", text: "你好" }],
    sequence: 0,
  });
});

afterAll(async () => {
  await database.db.delete(user).where(eq(user.id, ownerId));
  await database.close();
});

describe("PostgreSQL 业务不变量", () => {
  it("Conversation mode 创建后不可修改", async () => {
    await expect(
      database.db
        .update(conversations)
        .set({ mode: "image" })
        .where(eq(conversations.id, conversationId)),
    ).rejects.toThrow();

    const persistedConversation = await database.db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    });

    expect(persistedConversation?.mode).toBe("chat");
  });

  it("同一 Conversation 的 Message sequence 不可重复", async () => {
    await expect(
      database.db.insert(messages).values({
        id: `db-test-duplicate-message-${randomUUID()}`,
        conversationId,
        role: "assistant",
        parts: [{ id: "duplicate-text", type: "text", text: "重复序号" }],
        sequence: 0,
      }),
    ).rejects.toThrow();
  });

  it("同一 Conversation 同时最多一个 Active Generation", async () => {
    const firstGenerationId = `db-test-generation-${randomUUID()}`;
    const secondGenerationId = `db-test-generation-${randomUUID()}`;

    await database.db.insert(generations).values({
      id: firstGenerationId,
      conversationId,
      userMessageId,
      status: "queued",
    });

    await expect(
      database.db.insert(generations).values({
        id: secondGenerationId,
        conversationId,
        userMessageId,
        status: "running",
      }),
    ).rejects.toThrow();

    await database.db
      .update(generations)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(generations.id, firstGenerationId));

    await expect(
      database.db.insert(generations).values({
        id: secondGenerationId,
        conversationId,
        userMessageId,
        status: "running",
      }),
    ).resolves.toBeDefined();
  });

  it("Attachment 大小必须有效，object key 不可重复", async () => {
    const objectKey = `attachments/db-test-${randomUUID()}`;

    await expect(
      database.db.insert(attachments).values({
        id: `db-test-empty-attachment-${randomUUID()}`,
        ownerId,
        objectKey: `${objectKey}-empty`,
        originalName: "empty.pdf",
        mediaType: "application/pdf",
        sizeBytes: 0,
      }),
    ).rejects.toThrow();

    await database.db.insert(attachments).values({
      id: `db-test-attachment-${randomUUID()}`,
      ownerId,
      objectKey,
      originalName: "diagram.png",
      mediaType: "image/png",
      sizeBytes: 1024,
    });

    await expect(
      database.db.insert(attachments).values({
        id: `db-test-duplicate-attachment-${randomUUID()}`,
        ownerId,
        objectKey,
        originalName: "another.png",
        mediaType: "image/png",
        sizeBytes: 2048,
      }),
    ).rejects.toThrow();
  });

  it("用户工具偏好按用户唯一保存，并随用户删除", async () => {
    await database.db.insert(userToolPreferences).values({
      userId: ownerId,
      mcpToolIds: ["fortune.draw_tarot_reading"],
    });

    await database.db
      .insert(userToolPreferences)
      .values({
        userId: ownerId,
        mcpToolIds: ["baidu-maps.map_weather"],
      })
      .onConflictDoUpdate({
        target: userToolPreferences.userId,
        set: { mcpToolIds: ["baidu-maps.map_weather"] },
      });

    const preferences =
      await database.db.query.userToolPreferences.findFirst({
        where: eq(userToolPreferences.userId, ownerId),
      });

    expect(preferences?.mcpToolIds).toEqual(["baidu-maps.map_weather"]);
  });
});
