import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import type { CreateGenerationRequest } from "@ai-chat/contracts";
import {
  attachments,
  closeApplicationDatabase,
  conversations,
  createDatabase,
  generations,
  messages,
  migrateDatabase,
  user,
} from "@ai-chat/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createGenerationForOwner,
  type GenerationQueueProducer,
  GenerationServiceError,
} from "./generations";

const localEnvironment = fileURLToPath(
  new URL("../../.env.local", import.meta.url),
);

if (existsSync(localEnvironment)) {
  loadEnvFile(localEnvironment);
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error("缺少 TEST_DATABASE_URL");
}

process.env.DATABASE_URL = testDatabaseUrl;

const database = createDatabase(testDatabaseUrl, 1);
class FakeGenerationQueue implements GenerationQueueProducer {
  readonly jobs = new Map<string, { generationId: string }>();

  async enqueue(payload: { generationId: string }) {
    this.jobs.set(payload.generationId, payload);
  }
}

const queue = new FakeGenerationQueue();
const ownerId = `generation-owner-${randomUUID()}`;
const otherOwnerId = `generation-other-${randomUUID()}`;

beforeAll(async () => {
  await migrateDatabase({
    databaseUrl: testDatabaseUrl,
    migrationsFolder: fileURLToPath(
      new URL("../../../../packages/db/drizzle", import.meta.url),
    ),
  });
  await database.db.insert(user).values([
    {
      id: ownerId,
      name: "Generation Owner",
      email: `${ownerId}@example.com`,
    },
    {
      id: otherOwnerId,
      name: "Generation Other",
      email: `${otherOwnerId}@example.com`,
    },
  ]);
});

afterAll(async () => {
  await database.client`DELETE FROM "user" WHERE id IN (${ownerId}, ${otherOwnerId})`;
  await database.close();
  await closeApplicationDatabase();
});

describe("Generation creation service", () => {
  it("事务创建新 Conversation、User Message、queued Generation 并真实入队", async () => {
    const attachmentId = `generation-attachment-${randomUUID()}`;
    const userMessageId = `generation-message-${randomUUID()}`;
    const conversationId = `generation-conversation-${randomUUID()}`;
    const generationId = `generation-${randomUUID()}`;
    const now = new Date("2026-08-27T12:00:00.000Z");
    const request = {
      target: { type: "new", mode: "chat" },
      userMessageId,
      parts: [
        { type: "text", text: "解释一下 Redis Streams" },
        { type: "attachment", attachmentId },
      ],
      reasoningEffort: "medium",
    } satisfies CreateGenerationRequest;

    await database.db.insert(attachments).values({
      id: attachmentId,
      ownerId,
      objectKey: `attachments/${attachmentId}`,
      originalName: "stream.pdf",
      mediaType: "application/pdf",
      sizeBytes: 1024,
      status: "ready",
      readyAt: now,
    });

    const response = await createGenerationForOwner(ownerId, request, {
      queue,
      createConversationId: () => conversationId,
      createGenerationId: () => generationId,
      now: () => now,
    });

    expect(response).toEqual({
      conversationId,
      generation: {
        id: generationId,
        userMessageId,
        status: "queued",
        reasoningEffort: "medium",
        createdAt: now.toISOString(),
      },
    });
    expect(queue.jobs.get(generationId)).toEqual({ generationId });
    await expect(
      database.db.query.conversations.findFirst({
        where: (table, { eq }) => eq(table.id, conversationId),
      }),
    ).resolves.toMatchObject({
      ownerId,
      mode: "chat",
      title: "解释一下 Redis Streams",
    });
    await expect(
      database.db.query.messages.findFirst({
        where: (table, { eq }) => eq(table.id, userMessageId),
      }),
    ).resolves.toMatchObject({
      conversationId,
      sequence: 0,
      parts: request.parts,
    });
    await expect(
      database.db.query.attachments.findFirst({
        where: (table, { eq }) => eq(table.id, attachmentId),
      }),
    ).resolves.toMatchObject({ linkedAt: now });
  });

  it("相同 userMessageId 与相同 parts 返回原 Generation，并沿用稳定 job ID", async () => {
    const userMessageId = `generation-idempotent-message-${randomUUID()}`;
    const firstGenerationId = `generation-idempotent-${randomUUID()}`;
    const request = {
      target: { type: "new", mode: "chat" },
      userMessageId,
      parts: [{ type: "text", text: "幂等请求" }],
      reasoningEffort: "low",
    } satisfies CreateGenerationRequest;
    const first = await createGenerationForOwner(ownerId, request, {
      queue,
      createConversationId: () => `conversation-${randomUUID()}`,
      createGenerationId: () => firstGenerationId,
    });
    const retry = await createGenerationForOwner(ownerId, request, {
      queue,
      createConversationId: () => `unused-conversation-${randomUUID()}`,
      createGenerationId: () => `unused-generation-${randomUUID()}`,
    });

    expect(retry).toEqual(first);
    expect(queue.jobs.get(firstGenerationId)).toEqual({
      generationId: firstGenerationId,
    });

    await expect(
      createGenerationForOwner(
        ownerId,
        { ...request, parts: [{ type: "text", text: "篡改内容" }] },
        { queue },
      ),
    ).rejects.toMatchObject({
      response: { code: "MESSAGE_ID_CONFLICT" },
      status: 409,
    } satisfies Partial<GenerationServiceError>);
  });

  it("已有 Active Generation 时返回其 ID，不写入第二条 Message", async () => {
    const conversationId = `generation-active-conversation-${randomUUID()}`;
    const firstMessageId = `generation-active-first-message-${randomUUID()}`;
    const firstGenerationId = `generation-active-first-${randomUUID()}`;
    await database.db.insert(conversations).values({
      id: conversationId,
      ownerId,
      mode: "chat",
      title: "Active Generation",
    });
    await database.db.insert(messages).values({
      id: firstMessageId,
      conversationId,
      role: "user",
      parts: [{ type: "text", text: "第一条" }],
      sequence: 0,
    });
    await database.db.insert(generations).values({
      id: firstGenerationId,
      conversationId,
      userMessageId: firstMessageId,
      status: "running",
      reasoningEffort: "medium",
    });

    await expect(
      createGenerationForOwner(
        ownerId,
        {
          target: { type: "existing", conversationId },
          userMessageId: `generation-active-second-message-${randomUUID()}`,
          parts: [{ type: "text", text: "第二条" }],
          reasoningEffort: "medium",
        },
        { queue },
      ),
    ).rejects.toMatchObject({
      response: {
        code: "ACTIVE_GENERATION",
        activeGenerationId: firstGenerationId,
      },
      status: 409,
    } satisfies Partial<GenerationServiceError>);
  });

  it("拒绝未 ready、其他用户和不符合 Image 模式的 Attachment", async () => {
    const pendingAttachmentId = `generation-pending-${randomUUID()}`;
    const privateAttachmentId = `generation-private-${randomUUID()}`;
    const pdfAttachmentId = `generation-image-pdf-${randomUUID()}`;
    const now = new Date();
    await database.db.insert(attachments).values([
      {
        id: pendingAttachmentId,
        ownerId,
        objectKey: `attachments/${pendingAttachmentId}`,
        originalName: "pending.png",
        mediaType: "image/png",
        sizeBytes: 100,
      },
      {
        id: privateAttachmentId,
        ownerId: otherOwnerId,
        objectKey: `attachments/${privateAttachmentId}`,
        originalName: "private.png",
        mediaType: "image/png",
        sizeBytes: 100,
        status: "ready",
        readyAt: now,
      },
      {
        id: pdfAttachmentId,
        ownerId,
        objectKey: `attachments/${pdfAttachmentId}`,
        originalName: "paper.pdf",
        mediaType: "application/pdf",
        sizeBytes: 100,
        status: "ready",
        readyAt: now,
      },
    ]);

    const createWithAttachment = (attachmentId: string, mode: "chat" | "image") =>
      createGenerationForOwner(
        ownerId,
        {
          target: { type: "new", mode },
          userMessageId: `generation-validation-message-${randomUUID()}`,
          parts: [
            { type: "text", text: "读取附件" },
            { type: "attachment", attachmentId },
          ],
          reasoningEffort: mode === "chat" ? "medium" : null,
        },
        { queue },
      );

    await expect(createWithAttachment(pendingAttachmentId, "chat")).rejects.toMatchObject({
      response: { code: "ATTACHMENT_NOT_READY", attachmentId: pendingAttachmentId },
    });
    await expect(createWithAttachment(privateAttachmentId, "chat")).rejects.toMatchObject({
      response: { code: "ATTACHMENT_NOT_FOUND", attachmentId: privateAttachmentId },
    });
    await expect(createWithAttachment(pdfAttachmentId, "image")).rejects.toMatchObject({
      response: { code: "ATTACHMENT_MODE_MISMATCH", attachmentId: pdfAttachmentId },
    });
  });
});
