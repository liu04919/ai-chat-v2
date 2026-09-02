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
  conversations,
  createDatabase,
  createGenerationCommandRecord,
  createRegenerationCommandRecord,
  generations,
  messages,
  migrateDatabase,
  requestGenerationCancellationForOwner,
  user,
} from "@ai-chat/db";
import {
  createRedisGenerationCancellationPublisher,
  createRedisGenerationCancellationSubscriber,
  createRedisGenerationEventReader,
  createRedisGenerationEventWriter,
} from "@ai-chat/event-store";
import { Job, Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";
import { tool } from "ai";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  ChatModel,
  ChatModelRequest,
  ChatModelStreamPart,
} from "../llm/chat-model";
import { createBullMqGenerationWorker } from "./bullmq-generation-worker";
import { executeGeneration } from "./execute-generation";

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
const eventKeyPrefix = `worker-integration-${randomUUID()}`;
const cancellationChannelPrefix = `worker-cancellation-${randomUUID()}`;
const cancellationPublisher = createRedisGenerationCancellationPublisher({
  redisUrl,
  channelPrefix: cancellationChannelPrefix,
});
const cancellationSubscriber = createRedisGenerationCancellationSubscriber({
  redisUrl,
  channelPrefix: cancellationChannelPrefix,
});
const eventWriter = createRedisGenerationEventWriter({
  redisUrl,
  keyPrefix: eventKeyPrefix,
  ttlSeconds: 60,
});
const eventReader = createRedisGenerationEventReader({
  redisUrl,
  keyPrefix: eventKeyPrefix,
});
const capturedRequests: ChatModelRequest[] = [];
let modelCalls = 0;

function latestUserText(request: ChatModelRequest): string {
  const message = [...request.messages].reverse().find(
    (candidate) => candidate.role === "user",
  );

  return message?.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n") ?? "";
}

const fakeChatModel: ChatModel = {
  async *stream(request): AsyncIterable<ChatModelStreamPart> {
    modelCalls += 1;
    capturedRequests.push({
      messages: request.messages,
      reasoningEffort: request.reasoningEffort,
      ...(request.tools ? { tools: request.tools } : {}),
    });

    if (latestUserText(request).includes("工具调用")) {
      if (!request.tools?.web_search) {
        throw new Error("测试 Generation 没有收到 web_search Tool");
      }
      yield {
        type: "tool-call",
        partId: "tool-call:search-1",
        toolCallId: "search-1",
        toolName: "web_search",
        input: { query: "Redis latest" },
      };
      yield {
        type: "tool-result",
        partId: "tool-result:search-1",
        toolCallId: "search-1",
        output: { results: [{ title: "Redis", url: "https://redis.io/" }] },
        isError: false,
      };
      yield { type: "text", partId: "tool-answer", delta: "查询完成" };
      yield { type: "finish", reason: "stop" };
      return;
    }

    if (latestUserText(request).includes("触发失败")) {
      yield { type: "text", partId: "failed-text", delta: "部分" };
      throw new Error("Fake LLM failure");
    }

    if (latestUserText(request).includes("等待无输出取消")) {
      await new Promise<void>((resolve) => {
        if (request.abortSignal?.aborted) {
          resolve();
          return;
        }

        request.abortSignal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      request.abortSignal?.throwIfAborted();
    }

    if (latestUserText(request).includes("等待取消")) {
      yield {
        type: "reasoning",
        partId: "cancel-reasoning",
        delta: "分析到一半",
      };
      await new Promise<void>((resolve) => {
        if (request.abortSignal?.aborted) {
          resolve();
          return;
        }

        request.abortSignal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      request.abortSignal?.throwIfAborted();
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
    executeGeneration(generationId, {
      chatModel: fakeChatModel,
      imageModel: {
        generate: async () => {
          throw new Error("Chat 不能进入 Image Model");
        },
      },
      cancellationSubscriber,
      eventWriter,
      objectStorage: {
        createDownloadUrl,
        readObject: async () => {
          throw new Error("Chat 不能读取图片二进制");
        },
        writeObject: async () => {
          throw new Error("Chat 不能写入图片二进制");
        },
        deleteObject: async () => {
          throw new Error("Chat 不能删除图片");
        },
      },
      toolResolver: {
        async resolve(selection) {
          return {
            tools: selection.webSearch
              ? {
                  web_search: tool({
                    description: "测试联网搜索",
                    inputSchema: z.object({ query: z.string() }),
                    execute: async ({ query }) => ({ query, results: [] }),
                  }),
                }
              : undefined,
            toPublicToolName: (runtimeName) => runtimeName,
            close: async () => {},
          };
        },
      },
      coalescing: { maxDelayMs: 1000, maxCharacters: 128 },
      createAssistantMessageId: () => `assistant-${randomUUID()}`,
    }),
});

async function createQueuedGeneration(input: {
  generationId: string;
  conversationId: string;
  userMessageId: string;
  parts: CreateGenerationRequest["parts"];
  tools?: CreateGenerationRequest["tools"];
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
      tools: input.tools ?? { webSearch: false, mcpToolIds: [] },
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
      tools: { webSearch: false, mcpToolIds: [] },
      conversationTitle: "不会用于已有 Conversation",
      now: new Date(),
    },
    database.db,
  );

  expect(result.kind).toBe("created");
}

async function seedCompletedAnswer(input: {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  sourceGenerationId: string;
  userText: string;
  assistantText: string;
}) {
  await database.db.insert(conversations).values({
    id: input.conversationId,
    ownerId,
    mode: "chat",
    title: input.userText,
  });
  await database.db.insert(messages).values([
    {
      id: input.userMessageId,
      conversationId: input.conversationId,
      role: "user",
      parts: [{ type: "text", text: input.userText }],
      sequence: 0,
    },
    {
      id: input.assistantMessageId,
      conversationId: input.conversationId,
      role: "assistant",
      parts: [{ id: "old-text", type: "text", text: input.assistantText }],
      sequence: 1,
    },
  ]);
  await database.db.insert(generations).values({
    id: input.sourceGenerationId,
    conversationId: input.conversationId,
    userMessageId: input.userMessageId,
    assistantMessageId: input.assistantMessageId,
    status: "completed",
    reasoningEffort: "medium",
    finishedAt: new Date(),
  });
}

async function createQueuedRegeneration(input: {
  generationId: string;
  conversationId: string;
  assistantMessageId: string;
}) {
  const result = await createRegenerationCommandRecord(
    {
      ownerId,
      generationId: input.generationId,
      conversationId: input.conversationId,
      assistantMessageId: input.assistantMessageId,
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

async function waitForGenerationEvent(
  generationId: string,
  eventType: "generation.started" | "reasoning.delta",
): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const events = await eventReader.read({ generationId });

    if (events.some((entry) => entry.event.type === eventType)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("等待 " + eventType + " 超时");
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
  await eventReader.close();
  await eventWriter.close();
  await cancellationSubscriber.close();
  await cancellationPublisher.close();
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
      (await eventReader.read({ generationId })).map((entry) => entry.event),
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

  it("把 Tool 事件写入 Redis，并按原顺序持久化到 Assistant Message", async () => {
    const generationId = `worker-tool-generation-${randomUUID()}`;
    const conversationId = `worker-tool-conversation-${randomUUID()}`;
    await createQueuedGeneration({
      generationId,
      conversationId,
      userMessageId: `worker-tool-message-${randomUUID()}`,
      parts: [{ type: "text", text: "执行一次工具调用" }],
      tools: { webSearch: true, mcpToolIds: [] },
    });

    const job = await enqueue(generationId);
    await job.waitUntilFinished(queueEvents, 5_000);

    expect(Object.keys(capturedRequests.at(-1)?.tools ?? {})).toEqual([
      "web_search",
    ]);
    expect(
      (await eventReader.read({ generationId })).map((entry) => entry.event),
    ).toEqual([
      { type: "generation.started", generationId },
      {
        type: "tool.call",
        generationId,
        partId: "tool-call:search-1",
        toolCallId: "search-1",
        toolName: "web_search",
        input: { query: "Redis latest" },
      },
      {
        type: "tool.result",
        generationId,
        partId: "tool-result:search-1",
        toolCallId: "search-1",
        output: {
          results: [{ title: "Redis", url: "https://redis.io/" }],
        },
        isError: false,
      },
      {
        type: "text.delta",
        generationId,
        partId: "tool-answer",
        delta: "查询完成",
      },
      { type: "generation.completed", generationId },
    ]);
    await expect(
      database.db.query.messages.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.conversationId, conversationId),
            eq(table.role, "assistant"),
          ),
      }),
    ).resolves.toMatchObject({
      parts: [
        {
          id: "tool-call:search-1",
          type: "tool-call",
          toolCallId: "search-1",
          toolName: "web_search",
          input: { query: "Redis latest" },
        },
        {
          id: "tool-result:search-1",
          type: "tool-result",
          toolCallId: "search-1",
          output: {
            results: [{ title: "Redis", url: "https://redis.io/" }],
          },
          isError: false,
        },
        { id: "tool-answer", type: "text", text: "查询完成" },
      ],
    });
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

  it("重新生成先删除旧回答，再沿用普通 Generation 路径保存新回答", async () => {
    const conversationId = `worker-regenerate-conversation-${randomUUID()}`;
    const userMessageId = `worker-regenerate-user-${randomUUID()}`;
    const assistantMessageId = `worker-regenerate-assistant-${randomUUID()}`;
    const sourceGenerationId = `worker-regenerate-source-${randomUUID()}`;
    const regenerationId = `worker-regenerate-${randomUUID()}`;
    const requestOffset = capturedRequests.length;
    await seedCompletedAnswer({
      conversationId,
      userMessageId,
      assistantMessageId,
      sourceGenerationId,
      userText: "请重新回答这个问题",
      assistantText: "旧回答",
    });
    await createQueuedRegeneration({
      generationId: regenerationId,
      conversationId,
      assistantMessageId,
    });

    await expect(
      database.db.query.messages.findFirst({
        where: (table, { eq }) => eq(table.id, assistantMessageId),
      }),
    ).resolves.toBeUndefined();

    const job = await enqueue(regenerationId);
    await job.waitUntilFinished(queueEvents, 5_000);

    expect(capturedRequests[requestOffset]).toEqual({
      reasoningEffort: "medium",
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: "请重新回答这个问题" }],
        },
      ],
    });
    const persistedMessages = await database.db.query.messages.findMany({
      where: (table, { eq }) => eq(table.conversationId, conversationId),
      orderBy: (table, { asc }) => asc(table.sequence),
    });
    expect(persistedMessages).toMatchObject([
      { id: userMessageId, role: "user", sequence: 0 },
      {
        role: "assistant",
        sequence: 1,
        parts: [
          { id: "reasoning-1", type: "reasoning", text: "先分析" },
          { id: "text-1", type: "text", text: "你好" },
        ],
      },
    ]);
    expect(persistedMessages[1]?.id).not.toBe(assistantMessageId);
    await expect(
      database.db.query.generations.findFirst({
        where: (table, { eq }) => eq(table.id, sourceGenerationId),
      }),
    ).resolves.toMatchObject({ assistantMessageId: null });
    await expect(
      database.db.query.generations.findFirst({
        where: (table, { eq }) => eq(table.id, regenerationId),
      }),
    ).resolves.toMatchObject({
      status: "completed",
      assistantMessageId: persistedMessages[1]?.id,
    });
  });

  it("重新生成被停止时与普通生成一样保存半截新流", async () => {
    const conversationId = `worker-regenerate-cancel-conversation-${randomUUID()}`;
    const userMessageId = `worker-regenerate-cancel-user-${randomUUID()}`;
    const assistantMessageId = `worker-regenerate-cancel-assistant-${randomUUID()}`;
    const sourceGenerationId = `worker-regenerate-cancel-source-${randomUUID()}`;
    const regenerationId = `worker-regenerate-cancel-${randomUUID()}`;
    await seedCompletedAnswer({
      conversationId,
      userMessageId,
      assistantMessageId,
      sourceGenerationId,
      userText: "等待取消",
      assistantText: "必须保留的旧回答",
    });
    await createQueuedRegeneration({
      generationId: regenerationId,
      conversationId,
      assistantMessageId,
    });

    const job = await enqueue(regenerationId);
    await waitForGenerationEvent(regenerationId, "reasoning.delta");
    await requestGenerationCancellationForOwner(
      { ownerId, generationId: regenerationId, now: new Date() },
      database.db,
    );
    await cancellationPublisher.publish(regenerationId);
    await expect(job.waitUntilFinished(queueEvents, 5_000)).resolves.toMatchObject({
      kind: "cancelled",
    });

    await expect(
      database.db.query.messages.findMany({
        where: (table, { eq }) => eq(table.conversationId, conversationId),
        orderBy: (table, { asc }) => asc(table.sequence),
      }),
    ).resolves.toMatchObject([
      { id: userMessageId, role: "user", sequence: 0 },
      {
        role: "assistant",
        sequence: 1,
        parts: [
          {
            id: "cancel-reasoning",
            type: "reasoning",
            text: "分析到一半",
          },
        ],
      },
    ]);
    await expect(
      database.db.query.generations.findFirst({
        where: (table, { eq }) => eq(table.id, regenerationId),
      }),
    ).resolves.toMatchObject({
      status: "cancelled",
      assistantMessageId: expect.any(String),
    });
    await expect(
      database.db.query.generations.findFirst({
        where: (table, { eq }) => eq(table.id, sourceGenerationId),
      }),
    ).resolves.toMatchObject({ assistantMessageId: null });
  });

  it("重新生成失败时不恢复已经删除的旧回答", async () => {
    const conversationId = `worker-regenerate-fail-conversation-${randomUUID()}`;
    const userMessageId = `worker-regenerate-fail-user-${randomUUID()}`;
    const assistantMessageId = `worker-regenerate-fail-assistant-${randomUUID()}`;
    const sourceGenerationId = `worker-regenerate-fail-source-${randomUUID()}`;
    const regenerationId = `worker-regenerate-fail-${randomUUID()}`;
    await seedCompletedAnswer({
      conversationId,
      userMessageId,
      assistantMessageId,
      sourceGenerationId,
      userText: "触发失败",
      assistantText: "不会恢复的旧回答",
    });
    await createQueuedRegeneration({
      generationId: regenerationId,
      conversationId,
      assistantMessageId,
    });

    const job = await enqueue(regenerationId);
    await expect(job.waitUntilFinished(queueEvents, 5_000)).rejects.toThrow(
      "Fake LLM failure",
    );

    await expect(
      database.db.query.messages.findMany({
        where: (table, { eq }) => eq(table.conversationId, conversationId),
      }),
    ).resolves.toMatchObject([
      { id: userMessageId, role: "user", sequence: 0 },
    ]);
    await expect(
      database.db.query.generations.findFirst({
        where: (table, { eq }) => eq(table.id, regenerationId),
      }),
    ).resolves.toMatchObject({
      status: "failed",
      assistantMessageId: null,
      errorCode: "CHAT_GENERATION_FAILED",
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
      (await eventReader.read({ generationId })).map((entry) => entry.event),
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

  it("收到跨进程取消信号后停止模型并持久化 reasoning-only partial", async () => {
    const generationId = `worker-cancel-generation-${randomUUID()}`;
    const conversationId = `worker-cancel-conversation-${randomUUID()}`;
    await createQueuedGeneration({
      generationId,
      conversationId,
      userMessageId: `worker-cancel-message-${randomUUID()}`,
      parts: [{ type: "text", text: "等待取消" }],
    });

    const job = await enqueue(generationId);
    await waitForGenerationEvent(generationId, "reasoning.delta");
    const cancellation = await requestGenerationCancellationForOwner(
      { ownerId, generationId, now: new Date() },
      database.db,
    );
    expect(cancellation.kind).toBe("running_requested");
    await cancellationPublisher.publish(generationId);

    await expect(
      job.waitUntilFinished(queueEvents, 5_000),
    ).resolves.toMatchObject({ kind: "cancelled" });
    await expect(
      database.db.query.generations.findFirst({
        where: (table, { eq }) => eq(table.id, generationId),
      }),
    ).resolves.toMatchObject({
      status: "cancelled",
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
          {
            id: "cancel-reasoning",
            type: "reasoning",
            text: "分析到一半",
          },
        ],
      },
    ]);
    expect(
      (await eventReader.read({ generationId })).map((entry) => entry.event),
    ).toEqual([
      { type: "generation.started", generationId },
      {
        type: "reasoning.delta",
        generationId,
        partId: "cancel-reasoning",
        delta: "分析到一半",
      },
      { type: "generation.cancelled", generationId },
    ]);

    const nextGenerationId = `worker-after-cancel-${randomUUID()}`;
    const requestOffset = capturedRequests.length;
    await createExistingQueuedGeneration({
      generationId: nextGenerationId,
      conversationId,
      userMessageId: `worker-after-cancel-message-${randomUUID()}`,
      parts: [{ type: "text", text: "沿着刚才的内容继续" }],
    });
    const nextJob = await enqueue(nextGenerationId);
    await nextJob.waitUntilFinished(queueEvents, 5_000);

    expect(capturedRequests[requestOffset]).toMatchObject({
      messages: [
        { role: "user", parts: [{ type: "text", text: "等待取消" }] },
        {
          role: "assistant",
          parts: [
            {
              id: "cancel-reasoning",
              type: "reasoning",
              text: "分析到一半",
            },
          ],
        },
        {
          role: "user",
          parts: [{ type: "text", text: "沿着刚才的内容继续" }],
        },
      ],
    });
  });

  it("模型尚无可见输出时取消，不创建空 Assistant Message", async () => {
    const generationId = `worker-cancel-empty-${randomUUID()}`;
    const conversationId = `worker-cancel-empty-conversation-${randomUUID()}`;
    await createQueuedGeneration({
      generationId,
      conversationId,
      userMessageId: `worker-cancel-empty-message-${randomUUID()}`,
      parts: [{ type: "text", text: "等待无输出取消" }],
    });

    const job = await enqueue(generationId);
    await waitForGenerationEvent(generationId, "generation.started");
    await requestGenerationCancellationForOwner(
      { ownerId, generationId, now: new Date() },
      database.db,
    );
    await cancellationPublisher.publish(generationId);
    await job.waitUntilFinished(queueEvents, 5_000);

    await expect(
      database.db.query.generations.findFirst({
        where: (table, { eq }) => eq(table.id, generationId),
      }),
    ).resolves.toMatchObject({
      status: "cancelled",
      assistantMessageId: null,
    });
    await expect(
      database.db.query.messages.findMany({
        where: (table, { eq }) => eq(table.conversationId, conversationId),
      }),
    ).resolves.toHaveLength(1);
  });
});
