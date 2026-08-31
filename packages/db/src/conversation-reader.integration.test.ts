import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "./client";
import {
  getConversationRecordForOwner,
  listConversationRecordsForOwner,
} from "./conversation-reader";
import { migrateDatabase } from "./migration";
import { conversations, generations, messages, user } from "./schema/index";
import { loadIntegrationTestEnvironment } from "./test-environment";
import { claimGenerationExecution } from "./generation-execution";

const testDatabaseUrl = loadIntegrationTestEnvironment();
const database = createDatabase(testDatabaseUrl, 1);
const ownerId = `conversation-reader-owner-${randomUUID()}`;
const otherOwnerId = `conversation-reader-other-${randomUUID()}`;
const olderConversationId = `conversation-reader-older-${randomUUID()}`;
const newerConversationId = `conversation-reader-newer-${randomUUID()}`;
const otherConversationId = `conversation-reader-private-${randomUUID()}`;
const activeUserMessageId = `conversation-reader-message-${randomUUID()}`;
const activeGenerationId = `conversation-reader-generation-${randomUUID()}`;

beforeAll(async () => {
  await migrateDatabase({
    databaseUrl: testDatabaseUrl,
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });

  await database.db.insert(user).values([
    {
      id: ownerId,
      name: "Conversation Reader Owner",
      email: `${ownerId}@example.com`,
    },
    {
      id: otherOwnerId,
      name: "Conversation Reader Other",
      email: `${otherOwnerId}@example.com`,
    },
  ]);

  await database.db.insert(conversations).values([
    {
      id: olderConversationId,
      ownerId,
      mode: "chat",
      title: "较早的对话",
      createdAt: new Date("2026-08-26T08:00:00.000Z"),
      updatedAt: new Date("2026-08-26T08:00:00.000Z"),
    },
    {
      id: newerConversationId,
      ownerId,
      mode: "chat",
      title: "最近的对话",
      createdAt: new Date("2026-08-26T09:00:00.000Z"),
      updatedAt: new Date("2026-08-26T10:00:00.000Z"),
    },
    {
      id: otherConversationId,
      ownerId: otherOwnerId,
      mode: "image",
      title: "其他用户的私有对话",
    },
  ]);

  await database.db.insert(messages).values({
    id: activeUserMessageId,
    conversationId: newerConversationId,
    role: "user",
    parts: [{ type: "text", text: "继续生成" }],
    sequence: 0,
  });
  await database.db.insert(generations).values({
    id: activeGenerationId,
    conversationId: newerConversationId,
    userMessageId: activeUserMessageId,
    status: "running",
  });
});

afterAll(async () => {
  await database.db.delete(user).where(eq(user.id, ownerId));
  await database.db.delete(user).where(eq(user.id, otherOwnerId));
  await database.close();
});

describe("Conversation ownership queries", () => {
  it("最新 30 条向前分页，新增消息不打乱游标；Worker 仍读取完整上下文", async () => {
    const id = randomUUID();
    const rows = Array.from({ length: 75 }, (_, index) => ({
      id: randomUUID(), conversationId: id, role: "user" as const,
      sequence: index * 2,
      parts: [{ type: "text" as const, text: `历史 ${index}` }],
    }));
    await database.db.insert(conversations).values({ id, ownerId, mode: "chat", title: "分页测试" });
    try {
      await database.db.insert(messages).values(rows);
      const read = (before?: number) => getConversationRecordForOwner(ownerId, id, { database: database.db, before });
      const first = (await read())!;
      expect(first.messages.map((message) => message.sequence)).toEqual(rows.slice(-30).map((row) => row.sequence));
      expect(first.nextCursor).toBe(90);
      const newMessageId = randomUUID();
      await database.db.insert(messages).values({
        id: newMessageId, conversationId: id, role: "user", sequence: 150,
        parts: [{ type: "text", text: "分页期间新消息" }],
      });
      const second = (await read(first.nextCursor!))!;
      const third = (await read(second.nextCursor!))!;
      expect(second.messages).toHaveLength(30);
      expect(third.messages).toHaveLength(15);
      expect(third.nextCursor).toBeNull();
      const all = [...third.messages, ...second.messages, ...first.messages];
      expect(all.map((message) => message.id)).toEqual(rows.map((row) => row.id));
      expect((await read(0))?.messages).toEqual([]);
      expect((await read(0))?.nextCursor).toBeNull();
      expect(await getConversationRecordForOwner(otherOwnerId, id, { database: database.db, before: 90 })).toBeNull();

      const generationId = randomUUID();
      await database.db.insert(generations).values({ id: generationId, conversationId: id, userMessageId: newMessageId, reasoningEffort: "medium" });
      const claimed = await claimGenerationExecution(generationId, new Date(), database.db);
      expect(claimed.kind).toBe("claimed");
      if (claimed.kind !== "claimed") throw new Error("expected claimed generation");
      expect(claimed.execution.messages).toHaveLength(76);
      expect(claimed.execution.messages[0]?.parts).toEqual(rows[0]!.parts);
    } finally {
      await database.db.delete(conversations).where(eq(conversations.id, id));
    }
  });

  it("恰好一页不返回多余游标", async () => {
    const id = randomUUID();
    await database.db.insert(conversations).values({ id, ownerId, mode: "image", title: "整页测试" });
    try {
      await database.db.insert(messages).values(Array.from({ length: 30 }, (_, sequence) => ({
        id: randomUUID(), conversationId: id, role: "user" as const, sequence,
        parts: [{ type: "text" as const, text: "图片描述" }],
      })));
      const result = await getConversationRecordForOwner(ownerId, id, { database: database.db });
      expect(result?.messages).toHaveLength(30);
      expect(result?.nextCursor).toBeNull();
    } finally {
      await database.db.delete(conversations).where(eq(conversations.id, id));
    }
  });
  it("只返回当前用户的 Conversation，并按更新时间倒序排列", async () => {
    const result = await listConversationRecordsForOwner(ownerId, database.db);

    expect(result.map((conversation) => conversation.id)).toEqual([
      newerConversationId,
      olderConversationId,
    ]);
    expect(
      result.some((conversation) => conversation.id === otherConversationId),
    ).toBe(false);
    expect(result[0]?.updatedAt).toBeInstanceOf(Date);
  });

  it("详情包含数据库确认的 Active Generation", async () => {
    await expect(
      getConversationRecordForOwner(ownerId, newerConversationId, { database: database.db }),
    ).resolves.toMatchObject({
      conversation: {
        id: newerConversationId,
        mode: "chat",
        title: "最近的对话",
      },
      activeGeneration: {
        id: activeGenerationId,
        status: "running",
      },
      latestGeneration: { id: activeGenerationId, status: "running" },
      messages: [
        {
          id: activeUserMessageId,
          role: "user",
          parts: [{ type: "text", text: "继续生成" }],
          sequence: 0,
        },
      ],
    });
  });

  it("其他用户的 Conversation 对当前用户表现为不存在", async () => {
    await expect(
      getConversationRecordForOwner(ownerId, otherConversationId, { database: database.db }),
    ).resolves.toBeNull();
  });

  it("任务结束后保留最近一次状态，不需要创建占位 Assistant 消息", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      await database.db
        .update(generations)
        .set({ status, finishedAt: new Date() })
        .where(eq(generations.id, activeGenerationId));
      const detail = await getConversationRecordForOwner(
        ownerId,
        newerConversationId,
        { database: database.db },
      );
      expect(detail?.activeGeneration).toBeNull();
      expect(detail?.latestGeneration).toEqual({
        id: activeGenerationId,
        status,
      });
      expect(detail?.messages).toHaveLength(1);
      expect(detail?.messages[0]?.role).toBe("user");
    }
    const emptyDetail = await getConversationRecordForOwner(
      ownerId,
      olderConversationId,
      { database: database.db },
    );
    expect(emptyDetail?.latestGeneration).toBeNull();
  });
});
