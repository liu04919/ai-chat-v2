import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import {
  GENERATION_JOB_NAME,
  type CreateGenerationRequest,
} from "@ai-chat/contracts";
import {
  attachments,
  closeApplicationDatabase,
  createDatabase,
  createGenerationCommandRecord,
  migrateDatabase,
  user,
} from "@ai-chat/db";
import { createRedisGenerationEventStore } from "@ai-chat/event-store";
import { Job, Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  ChatModel,
  ChatModelRequest,
  ChatModelStreamPart,
} from "../llm/chat-model";
import { createBullMqGenerationWorker } from "./bullmq-generation-worker";
import { executeChatGeneration } from "./execute-chat-generation";

const localEnvironment = fileURLToPath(
  new URL("../../../web/.env.local", import.meta.url),
);

if (existsSync(localEnvironment)) {
  loadEnvFile(localEnvironment);
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error("缺少 TEST_DATABASE_URL");
}

process.env.DATABASE_URL = testDatabaseUrl;

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6380";
const database = createDatabase(testDatabaseUrl, 1);
const ownerId = `worker-owner-${randomUUID()}`;
const queueName = `generation-worker-integration-${randomUUID()}`;
const queueConnection = new IORedis(redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
const eventsConnection = new IORedis(redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: null,
});
const queue = new Queue(queueName, { connection: queueConnection });
const queueEvents = new QueueEvents(queueName, {
  connection: eventsConnection,
});
const eventStore = createRedisGenerationEventStore({
  redisUrl,
  keyPrefix: `worker-integration-${randomUUID()}`,
  ttlSeconds: 60,
});
const capturedRequests: ChatModelRequest[] = [];
let modelCalls = 0;

function requestText(request: ChatModelRequest): string {
  return request.messages
    .flatMap((message) =>
      message.role === "assistant"
        ? message.parts.flatMap((part) =>
            part.type === "text" || part.type === "reasoning"
              ? [part.text]
              : [],
          )
        : message.parts.flatMap((part) =>
            part.type === "text" ? [part.text] : [],
          ),
    )
    .join("\n");
}

const fakeChatModel: ChatModel = {
  async *stream(request): AsyncIterable<ChatModelStreamPart> {
    modelCalls += 1;
    capturedRequests.push(request);

    if (requestText(request).includes("触发失败")) {
      yield { type: "text", partId: "failed-text", delta: "部分" };
      throw new Error("Fake LLM failure");
    }

    yield { type: "reasoning", partId: "reasoning-1", delta: "先" };
    yield { type: "reasoning", partId: "reasoning-1", delta: "分析" };
    yield { type: "text", partId: "text-1", delta: "你" };
    yield { type: "text", partId: "text-1", delta: "好" };
    yield { type: "finish", reason: "stop" };
  },
};
const createDownloadUrl = vi.fn(
  async (objectKey: string) =>
    `https://r2.example.com/${encodeURIComponent(objectKey)}?signed=1`,
);
const worker = createBullMqGenerationWorker({
  redisUrl,
  queueName,
  processGeneration: (generationId) =>
    executeChatGeneration(generationId, {
      chatModel: fakeChatModel,
      eventStore,
      objectStorage: { createDownloadUrl },
      coalescing: { maxDelayMs: 1000, maxCharacters: 128 },
      createAssistantMessageId: () => `assistant-${randomUUID()}`,
    }),
});

async function createQueuedGeneration(input: {
  generationId: string;
  conversationId: string;
  userMessageId: string;
  parts: CreateGenerationRequest["parts"];
}) {
  const result = await createGenerationCommandRecord(
    {
      ownerId,
      generationId: input.generationId,
      target: {
        type: "new",
        conversationId: input.conversationId,
        mode: "chat",
      },
      userMessageId: input.userMessageId,
      parts: input.parts,
      reasoningEffort: "medium",
      conversationTitle: "Worker Integration",
      now: new Date(),
    },
    database.db,
  );

  expect(result.kind).toBe("created");
}

async function createExistingQueuedGeneration(input: {
  generationId: string;
  conversationId: string;
  userMessageId: string;
  parts: CreateGenerationRequest["parts"];
}) {
  const result = await createGenerationCommandRecord(
    {
      ownerId,
      generationId: input.generationId,
      target: {
        type: "existing",
        conversationId: input.conversationId,
      },
      userMessageId: input.userMessageId,
      parts: input.parts,
      reasoningEffort: "medium",
      conversationTitle: "不会用于已有 Conversation",
      now: new Date(),
    },
    database.db,
  );

  expect(result.kind).toBe("created");
}

async function enqueue(generationId: string): Promise<Job> {
  return queue.add(
    GENERATION_JOB_NAME,
    { generationId },
    { jobId: generationId, attempts: 1 },
  );
}

beforeAll(async () => {
  await migrateDatabase({
    databaseUrl: testDatabaseUrl,
    migrationsFolder: fileURLToPath(
      new URL("../../../../packages/db/drizzle", import.meta.url),
    ),
  });
  await database.db.insert(user).values({
    id: ownerId,
    name: "Worker Integration Owner",
    email: `${ownerId}@example.com`,
  });
  await Promise.all([queueEvents.waitUntilReady(), worker.waitUntilReady()]);
});

afterAll(async () => {
  await worker.close();
  await queue.obliterate({ force: true });
  await queueEvents.close();
  await queue.close();
  queueConnection.disconnect();
  eventsConnection.disconnect();
  await eventStore.close();
  await database.client`DELETE FROM "user" WHERE id = ${ownerId}`;
  await database.close();
  await closeApplicationDatabase();
});

describe("Chat Generation Worker 主链", () => {
  it("串通 Queue、Worker、R2 URL、Redis Event 与 PostgreSQL，并跳过重复 job", async () => {
    const generationId = `worker-generation-${randomUUID()}`;
    const conversationId = `worker-conversation-${randomUUID()}`;
    const userMessageId = `worker-message-${randomUUID()}`;
    const attachmentId = `worker-attachment-${randomUUID()}`;
    const objectKey = `attachments/${attachmentId}/paper.pdf`;
    await database.db.insert(attachments).values({
      id: attachmentId,
      ownerId,
      objectKey,
      originalName: "paper.pdf",
      mediaType: "application/pdf",
      sizeBytes: 256,
      status: "ready",
      readyAt: new Date(),
    });
    await createQueuedGeneration({
      generationId,
      conversationId,
      userMessageId,
      parts: [
        { type: "text", text: "读取附件并回答" },
        { type: "attachment", attachmentId },
      ],
    });

    const job = await enqueue(generationId);
    await job.waitUntilFinished(queueEvents, 5000);

    expect(modelCalls).toBe(1);
    expect(capturedRequests[0]).toEqual({
      reasoningEffort: "medium",
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "读取附件并回答" },
            {
              type: "file",
              url: `https://r2.example.com/${encodeURIComponent(objectKey)}?signed=1`,
              mediaType: "application/pdf",
              filename: "paper.pdf",
            },
          ],
        },
      ],
    });
    expect(createDownloadUrl).toHaveBeenCalledWith(objectKey, 900);
    expect(
      (await eventStore.read({ generationId })).map((entry) => entry.event),
    ).toEqual([
      { type: "generation.started", generationId },
      {
        type: "reasoning.delta",
        generationId,
        partId: "reasoning-1",
        delta: "先",
      },
      {
        type: "reasoning.delta",
        generationId,
        partId: "reasoning-1",
        delta: "分析",
      },
      {
        type: "text.delta",
        generationId,
        partId: "text-1",
        delta: "你好",
      },
      { type: "generation.completed", generationId },
    ]);
    await expect(
      database.db.query.generations.findFirst({
        where: (table, { eq }) => eq(table.id, generationId),
      }),
    ).resolves.toMatchObject({
      status: "completed",
      errorCode: null,
    });
    const persistedMessages = await database.db.query.messages.findMany({
      where: (table, { eq }) => eq(table.conversationId, conversationId),
      orderBy: (table, { asc }) => asc(table.sequence),
    });
    expect(persistedMessages).toMatchObject([
      { role: "user", sequence: 0 },
      {
        role: "assistant",
        sequence: 1,
        parts: [
          { id: "reasoning-1", type: "reasoning", text: "先分析" },
          { id: "text-1", type: "text", text: "你好" },
        ],
      },
    ]);

    await job.remove();
    const duplicateJob = await enqueue(generationId);
    await duplicateJob.waitUntilFinished(queueEvents, 5000);
    expect(modelCalls).toBe(1);
    expect(
      await database.db.query.messages.findMany({
        where: (table, { eq }) => eq(table.conversationId, conversationId),
      }),
    ).toHaveLength(2);
  });

  it("下一轮从 PostgreSQL 重建可见 reasoning 与 text", async () => {
    const conversationId = `worker-history-conversation-${randomUUID()}`;
    const firstGenerationId = `worker-history-generation-${randomUUID()}`;
    const requestOffset = capturedRequests.length;
    await createQueuedGeneration({
      generationId: firstGenerationId,
      conversationId,
      userMessageId: `worker-history-message-${randomUUID()}`,
      parts: [{ type: "text", text: "第一轮问题" }],
    });

    const firstJob = await enqueue(firstGenerationId);
    await firstJob.waitUntilFinished(queueEvents, 5000);

    const secondGenerationId = `worker-history-generation-${randomUUID()}`;
    await createExistingQueuedGeneration({
      generationId: secondGenerationId,
      conversationId,
      userMessageId: `worker-history-message-${randomUUID()}`,
      parts: [{ type: "text", text: "请检查上一轮思考" }],
    });
    const secondJob = await enqueue(secondGenerationId);
    await secondJob.waitUntilFinished(queueEvents, 5000);

    expect(capturedRequests[requestOffset + 1]).toEqual({
      reasoningEffort: "medium",
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: "第一轮问题" }],
        },
        {
          role: "assistant",
          parts: [
            { id: "reasoning-1", type: "reasoning", text: "先分析" },
            { id: "text-1", type: "text", text: "你好" },
          ],
        },
        {
          role: "user",
          parts: [{ type: "text", text: "请检查上一轮思考" }],
        },
      ],
    });
  });

  it("模型流失败时保留已发布 delta，并把 Generation 标记为 failed", async () => {
    const generationId = `worker-failed-generation-${randomUUID()}`;
    const conversationId = `worker-failed-conversation-${randomUUID()}`;
    await createQueuedGeneration({
      generationId,
      conversationId,
      userMessageId: `worker-failed-message-${randomUUID()}`,
      parts: [{ type: "text", text: "触发失败" }],
    });

    const job = await enqueue(generationId);
    await expect(job.waitUntilFinished(queueEvents, 5000)).rejects.toThrow(
      "Fake LLM failure",
    );
    await expect(
      database.db.query.generations.findFirst({
        where: (table, { eq }) => eq(table.id, generationId),
      }),
    ).resolves.toMatchObject({
      status: "failed",
      assistantMessageId: null,
      errorCode: "CHAT_GENERATION_FAILED",
    });
    expect(
      (await eventStore.read({ generationId })).map((entry) => entry.event),
    ).toEqual([
      { type: "generation.started", generationId },
      {
        type: "text.delta",
        generationId,
        partId: "failed-text",
        delta: "部分",
      },
      { type: "generation.failed", generationId },
    ]);
    expect(
      await database.db.query.messages.findMany({
        where: (table, { eq }) => eq(table.conversationId, conversationId),
      }),
    ).toHaveLength(1);
  });
});
