import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import type {
  CreateGenerationRequest,
  GenerationEventDto,
} from "@ai-chat/contracts";
import {
  attachments,
  claimGenerationExecution,
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
  cancelGenerationForOwner,
  GenerationCancellationServiceError,
} from "./generation-cancellation";
import {
  createGenerationForOwner,
  type GenerationQueueProducer,
  GenerationServiceError,
} from "./generations";
import {
  regenerateGenerationForOwner,
  RegenerationServiceError,
} from "./generation-regeneration";

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

class FakeCancellationPublisher {
  readonly published: string[] = [];

  async publish(generationId: string) {
    this.published.push(generationId);
  }
}

class FakeGenerationEventWriter {
  readonly events: GenerationEventDto[] = [];

  async append(event: GenerationEventDto) {
    this.events.push(event);
    return "1-0" as const;
  }
}

const queue = new FakeGenerationQueue();
const ownerId = `generation-owner-${randomUUID()}`;
const otherOwnerId = `generation-other-${randomUUID()}`;
const noTools: CreateGenerationRequest["tools"] = {
  webSearch: false,
  mcpToolIds: [],
};

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
      target: { type: "new", conversationId, mode: "chat" },
      userMessageId,
      parts: [
        { type: "text", text: "解释一下 Redis Streams" },
        { type: "attachment", attachmentId },
      ],
      reasoningEffort: "medium",
      tools: noTools,
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
    const conversationId = `generation-idempotent-conversation-${randomUUID()}`;
    const firstGenerationId = `generation-idempotent-${randomUUID()}`;
    const request = {
      target: { type: "new", conversationId, mode: "chat" },
      userMessageId,
      parts: [{ type: "text", text: "幂等请求" }],
      reasoningEffort: "low",
      tools: noTools,
    } satisfies CreateGenerationRequest;
    const first = await createGenerationForOwner(ownerId, request, {
      queue,
      createGenerationId: () => firstGenerationId,
    });
    const retry = await createGenerationForOwner(ownerId, request, {
      queue,
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

    await expect(
      createGenerationForOwner(
        ownerId,
        {
          ...request,
          target: {
            ...request.target,
            conversationId: `different-conversation-${randomUUID()}`,
          },
        },
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
          tools: noTools,
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

    const attemptedConversationIds: string[] = [];
    const initialJobs = queue.jobs.size;
    const createWithAttachment = (attachmentId: string, mode: "chat" | "image") => {
      const conversationId = `generation-validation-conversation-${randomUUID()}`;
      attemptedConversationIds.push(conversationId);
      return createGenerationForOwner(
        ownerId,
        {
          target: {
            type: "new",
            conversationId,
            mode,
          },
          userMessageId: `generation-validation-message-${randomUUID()}`,
          parts: [
            { type: "text", text: "读取附件" },
            { type: "attachment", attachmentId },
          ],
          reasoningEffort: mode === "chat" ? "medium" : null,
          tools: noTools,
        },
        { queue },
      );
    };

    await expect(createWithAttachment(pendingAttachmentId, "chat")).rejects.toMatchObject({
      response: { code: "ATTACHMENT_NOT_READY", attachmentId: pendingAttachmentId },
    });
    await expect(createWithAttachment(privateAttachmentId, "chat")).rejects.toMatchObject({
      response: { code: "ATTACHMENT_NOT_FOUND", attachmentId: privateAttachmentId },
    });
    await expect(createWithAttachment(pdfAttachmentId, "image")).rejects.toMatchObject({
      response: { code: "ATTACHMENT_MODE_MISMATCH", attachmentId: pdfAttachmentId },
    });
    const missingAttachmentId = `missing-${randomUUID()}`;
    await expect(createWithAttachment(missingAttachmentId, "chat")).rejects.toMatchObject({
      response: { code: "ATTACHMENT_NOT_FOUND", attachmentId: missingAttachmentId },
    });
    for (const conversationId of attemptedConversationIds) {
      expect(await database.client`SELECT id FROM conversations WHERE id = ${conversationId}`).toHaveLength(0);
      expect(await database.client`SELECT id FROM messages WHERE conversation_id = ${conversationId}`).toHaveLength(0);
      expect(await database.client`SELECT id FROM generations WHERE conversation_id = ${conversationId}`).toHaveLength(0);
    }
    expect(queue.jobs.size).toBe(initialJobs);
    const [attachment] = await database.client`SELECT linked_at FROM attachments WHERE id = ${pdfAttachmentId}`;
    expect(attachment!.linked_at).toBeNull();
  });
});

describe("Generation regeneration service", () => {
  it("复用原 User Message 与思考等级创建 queued Generation，并按新 Generation ID 入队", async () => {
    const conversationId = `regeneration-conversation-${randomUUID()}`;
    const userMessageId = `regeneration-user-${randomUUID()}`;
    const assistantMessageId = `regeneration-assistant-${randomUUID()}`;
    const sourceGenerationId = `regeneration-source-${randomUUID()}`;
    const regenerationId = `regeneration-${randomUUID()}`;
    const now = new Date("2026-09-01T12:00:00.000Z");
    await database.db.insert(conversations).values({
      id: conversationId,
      ownerId,
      mode: "chat",
      title: "重新生成",
    });
    await database.db.insert(messages).values([
      {
        id: userMessageId,
        conversationId,
        role: "user",
        parts: [{ type: "text", text: "换一种方式回答" }],
        sequence: 0,
      },
      {
        id: assistantMessageId,
        conversationId,
        role: "assistant",
        parts: [{ id: "old", type: "text", text: "旧回答" }],
        sequence: 1,
      },
    ]);
    await database.db.insert(generations).values({
      id: sourceGenerationId,
      conversationId,
      userMessageId,
      assistantMessageId,
      status: "completed",
      reasoningEffort: "high",
    });

    await expect(
      regenerateGenerationForOwner(
        ownerId,
        { conversationId, assistantMessageId },
        {
          queue,
          createGenerationId: () => regenerationId,
          now: () => now,
        },
      ),
    ).resolves.toEqual({
      conversationId,
      generation: {
        id: regenerationId,
        userMessageId,
        status: "queued",
        reasoningEffort: "high",
        createdAt: now.toISOString(),
      },
    });
    expect(queue.jobs.get(regenerationId)).toEqual({
      generationId: regenerationId,
    });
    await expect(
      database.db.query.generations.findFirst({
        where: (table, { eq }) => eq(table.id, regenerationId),
      }),
    ).resolves.toMatchObject({
      userMessageId,
      reasoningEffort: "high",
      status: "queued",
    });
    await expect(
      database.db.query.messages.findFirst({
        where: (table, { eq }) => eq(table.id, assistantMessageId),
      }),
    ).resolves.toBeUndefined();
    await expect(
      database.db.query.generations.findFirst({
        where: (table, { eq }) => eq(table.id, sourceGenerationId),
      }),
    ).resolves.toMatchObject({ assistantMessageId: null });
  });

  it("拒绝重新生成非末尾回答，并且不创建新 Generation", async () => {
    const conversationId = `regeneration-non-latest-${randomUUID()}`;
    const userMessageId = `regeneration-non-latest-user-${randomUUID()}`;
    const assistantMessageId = `regeneration-non-latest-assistant-${randomUUID()}`;
    await database.db.insert(conversations).values({
      id: conversationId,
      ownerId,
      mode: "chat",
      title: "非末尾回答",
    });
    await database.db.insert(messages).values([
      {
        id: userMessageId,
        conversationId,
        role: "user",
        parts: [{ type: "text", text: "第一问" }],
        sequence: 0,
      },
      {
        id: assistantMessageId,
        conversationId,
        role: "assistant",
        parts: [{ id: "old", type: "text", text: "第一答" }],
        sequence: 1,
      },
      {
        id: `regeneration-newer-user-${randomUUID()}`,
        conversationId,
        role: "user",
        parts: [{ type: "text", text: "第二问" }],
        sequence: 2,
      },
    ]);
    await database.db.insert(generations).values({
      id: `regeneration-non-latest-source-${randomUUID()}`,
      conversationId,
      userMessageId,
      assistantMessageId,
      status: "completed",
      reasoningEffort: "medium",
    });

    await expect(
      regenerateGenerationForOwner(
        ownerId,
        { conversationId, assistantMessageId },
        { queue },
      ),
    ).rejects.toMatchObject({
      response: { code: "REGENERATION_NOT_ALLOWED" },
      status: 409,
    } satisfies Partial<RegenerationServiceError>);
  });
});

describe("Generation cancellation service", () => {
  it("queued Generation 直接进入 cancelled，且不创建空 Assistant Message", async () => {
    const generationId = `generation-cancel-queued-${randomUUID()}`;
    const conversationId = `generation-cancel-conversation-${randomUUID()}`;
    const now = new Date("2026-08-30T09:00:00.000Z");
    await createGenerationForOwner(
      ownerId,
      {
        target: { type: "new", conversationId, mode: "chat" },
        userMessageId: `generation-cancel-message-${randomUUID()}`,
        parts: [{ type: "text", text: "尚未开始就停止" }],
        reasoningEffort: "medium",
        tools: noTools,
      },
      {
        queue,
        createGenerationId: () => generationId,
      },
    );
    const cancellationPublisher = new FakeCancellationPublisher();
    const eventWriter = new FakeGenerationEventWriter();

    await expect(
      cancelGenerationForOwner(ownerId, generationId, {
        cancellationPublisher,
        eventWriter,
        now: () => now,
      }),
    ).resolves.toEqual({
      generation: {
        id: generationId,
        status: "cancelled",
        cancelRequestedAt: now.toISOString(),
      },
    });
    expect(cancellationPublisher.published).toEqual([]);
    expect(eventWriter.events).toEqual([
      { type: "generation.cancelled", generationId },
    ]);
    await expect(
      database.db.query.generations.findFirst({
        where: (table, { eq }) => eq(table.id, generationId),
      }),
    ).resolves.toMatchObject({
      status: "cancelled",
      assistantMessageId: null,
      cancelRequestedAt: now,
      finishedAt: now,
    });
    await expect(
      database.db.query.messages.findMany({
        where: (table, { eq }) => eq(table.conversationId, conversationId),
      }),
    ).resolves.toHaveLength(1);
  });

  it("running Generation 持久化一次取消时间，重复请求会再次通知 Worker", async () => {
    const generationId = `generation-cancel-running-${randomUUID()}`;
    const conversationId = `generation-cancel-running-conversation-${randomUUID()}`;
    const firstRequestedAt = new Date("2026-08-30T10:00:00.000Z");
    const retryAt = new Date("2026-08-30T10:01:00.000Z");
    await createGenerationForOwner(
      ownerId,
      {
        target: { type: "new", conversationId, mode: "chat" },
        userMessageId: `generation-cancel-running-message-${randomUUID()}`,
        parts: [{ type: "text", text: "开始后停止" }],
        reasoningEffort: "high",
        tools: noTools,
      },
      {
        queue,
        createGenerationId: () => generationId,
      },
    );
    await claimGenerationExecution(
      generationId,
      firstRequestedAt,
      database.db,
    );
    const cancellationPublisher = new FakeCancellationPublisher();
    const eventWriter = new FakeGenerationEventWriter();

    const first = await cancelGenerationForOwner(ownerId, generationId, {
      cancellationPublisher,
      eventWriter,
      now: () => firstRequestedAt,
    });
    const retry = await cancelGenerationForOwner(ownerId, generationId, {
      cancellationPublisher,
      eventWriter,
      now: () => retryAt,
    });

    expect(first).toEqual(retry);
    expect(first.generation).toEqual({
      id: generationId,
      status: "running",
      cancelRequestedAt: firstRequestedAt.toISOString(),
    });
    expect(cancellationPublisher.published).toEqual([
      generationId,
      generationId,
    ]);
    expect(eventWriter.events).toEqual([]);
    await expect(
      cancelGenerationForOwner(otherOwnerId, generationId, {
        cancellationPublisher,
        eventWriter,
      }),
    ).rejects.toMatchObject({
      response: { code: "GENERATION_NOT_FOUND" },
      status: 404,
    } satisfies Partial<GenerationCancellationServiceError>);
  });
});
