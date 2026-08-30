import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import {
  conversations,
  createDatabase,
  generations,
  getGenerationRecordForOwner,
  messages,
  user,
} from "@ai-chat/db";
import {
  createRedisGenerationEventReader,
  createRedisGenerationEventWriter,
  type GenerationEventReader,
} from "@ai-chat/event-store";
import IORedis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { openGenerationEventStreamForOwner } from "./generation-event-stream";

const localEnvironment = fileURLToPath(
  new URL("../../.env.local", import.meta.url),
);

if (existsSync(localEnvironment)) {
  loadEnvFile(localEnvironment);
}

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const configuredRedisUrl = process.env.REDIS_URL;

if (!configuredTestDatabaseUrl || !configuredRedisUrl) {
  throw new Error("缺少 TEST_DATABASE_URL 或 REDIS_URL");
}

const testDatabaseUrl = configuredTestDatabaseUrl;
const redisUrl = configuredRedisUrl;
const database = createDatabase(testDatabaseUrl);
const keyPrefix = `generation-sse-integration-${randomUUID()}`;
const eventWriter = createRedisGenerationEventWriter({
  redisUrl,
  keyPrefix,
  ttlSeconds: 60,
});
const inspector = new IORedis(redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
const ownerId = `generation-sse-owner-${randomUUID()}`;
const otherOwnerId = `generation-sse-other-${randomUUID()}`;
const streamKeys = new Set<string>();
const readers = new Set<GenerationEventReader>();

function createReader(): GenerationEventReader {
  const reader = createRedisGenerationEventReader({ redisUrl, keyPrefix });
  readers.add(reader);
  return reader;
}

function dependencies(blockMs = 2_000) {
  return {
    findGeneration: (candidateOwnerId: string, generationId: string) =>
      getGenerationRecordForOwner(
        candidateOwnerId,
        generationId,
        database.db,
      ),
    createReader,
    readLimit: 2,
    blockMs,
  };
}

async function createGeneration(
  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled" = "running",
) {
  const conversationId = `generation-sse-conversation-${randomUUID()}`;
  const userMessageId = `generation-sse-message-${randomUUID()}`;
  const generationId = `generation-sse-generation-${randomUUID()}`;

  await database.db.insert(conversations).values({
    id: conversationId,
    ownerId,
    mode: "chat",
    title: "SSE Test",
  });
  await database.db.insert(messages).values({
    id: userMessageId,
    conversationId,
    role: "user",
    parts: [{ type: "text", text: "测试 SSE" }],
    sequence: 0,
  });
  await database.db.insert(generations).values({
    id: generationId,
    conversationId,
    userMessageId,
    status,
    reasoningEffort: "medium",
  });
  streamKeys.add(`${keyPrefix}:${generationId}:events`);

  return generationId;
}

async function readFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string | null> {
  const result = await reader.read();

  return result.done ? null : new TextDecoder().decode(result.value);
}

beforeAll(async () => {
  await database.db.insert(user).values([
    {
      id: ownerId,
      name: "Generation SSE Owner",
      email: `${ownerId}@example.com`,
      emailVerified: true,
    },
    {
      id: otherOwnerId,
      name: "Generation SSE Other",
      email: `${otherOwnerId}@example.com`,
      emailVerified: true,
    },
  ]);
});

afterAll(async () => {
  await Promise.all([...readers].map((reader) => reader.close()));

  if (streamKeys.size > 0) {
    await inspector.del(...streamKeys);
  }

  if (inspector.status === "wait") {
    inspector.disconnect();
  } else {
    await inspector.quit();
  }

  await eventWriter.close();
  await database.client`DELETE FROM "user" WHERE id IN (${ownerId}, ${otherOwnerId})`;
  await database.close();
});

describe("Generation SSE stream", () => {
  it("先追历史，再等待实时事件，并在终态关闭", async () => {
    const generationId = await createGeneration();
    const started = { type: "generation.started", generationId } as const;
    const reasoning = {
      type: "reasoning.delta",
      generationId,
      partId: "reasoning-1",
      delta: "先分析",
    } as const;
    const startedCursor = await eventWriter.append(started);
    const reasoningCursor = await eventWriter.append(reasoning);
    const stream = await openGenerationEventStreamForOwner(
      ownerId,
      generationId,
      undefined,
      dependencies(),
    );

    expect(stream).not.toBeNull();
    const reader = stream!.getReader();

    await expect(readFrame(reader)).resolves.toBe(
      `id: ${startedCursor}\ndata: ${JSON.stringify(started)}\n\n`,
    );
    await expect(readFrame(reader)).resolves.toBe(
      `id: ${reasoningCursor}\ndata: ${JSON.stringify(reasoning)}\n\n`,
    );

    const text = {
      type: "text.delta",
      generationId,
      partId: "text-1",
      delta: "答案",
    } as const;
    const completed = { type: "generation.completed", generationId } as const;
    const textCursor = await eventWriter.append(text);
    const completedCursor = await eventWriter.append(completed);

    await expect(readFrame(reader)).resolves.toBe(
      `id: ${textCursor}\ndata: ${JSON.stringify(text)}\n\n`,
    );
    await expect(readFrame(reader)).resolves.toBe(
      `id: ${completedCursor}\ndata: ${JSON.stringify(completed)}\n\n`,
    );
    await expect(readFrame(reader)).resolves.toBeNull();
  });

  it("从 Last-Event-ID 之后续传，不重复旧事件", async () => {
    const generationId = await createGeneration("completed");
    const startedCursor = await eventWriter.append({
      type: "generation.started",
      generationId,
    });
    const text = {
      type: "text.delta",
      generationId,
      partId: "text-1",
      delta: "续传",
    } as const;
    const completed = { type: "generation.completed", generationId } as const;
    const textCursor = await eventWriter.append(text);
    const completedCursor = await eventWriter.append(completed);
    const stream = await openGenerationEventStreamForOwner(
      ownerId,
      generationId,
      startedCursor,
      dependencies(),
    );
    const reader = stream!.getReader();

    await expect(readFrame(reader)).resolves.toBe(
      `id: ${textCursor}\ndata: ${JSON.stringify(text)}\n\n`,
    );
    await expect(readFrame(reader)).resolves.toBe(
      `id: ${completedCursor}\ndata: ${JSON.stringify(completed)}\n\n`,
    );
    await expect(readFrame(reader)).resolves.toBeNull();
  });

  it("重放 generation.cancelled 后关闭 SSE", async () => {
    const generationId = await createGeneration("cancelled");
    const cancelled = { type: "generation.cancelled", generationId } as const;
    const cursor = await eventWriter.append(cancelled);
    const stream = await openGenerationEventStreamForOwner(
      ownerId,
      generationId,
      undefined,
      dependencies(),
    );
    const reader = stream!.getReader();

    await expect(readFrame(reader)).resolves.toBe(
      `id: ${cursor}\ndata: ${JSON.stringify(cancelled)}\n\n`,
    );
    await expect(readFrame(reader)).resolves.toBeNull();
  });

  it("其他用户看到 not found，且不会创建 Redis Reader", async () => {
    const generationId = await createGeneration();
    const createReaderSpy = vi.fn(createReader);

    await expect(
      openGenerationEventStreamForOwner(
        otherOwnerId,
        generationId,
        undefined,
        { ...dependencies(), createReader: createReaderSpy },
      ),
    ).resolves.toBeNull();
    expect(createReaderSpy).not.toHaveBeenCalled();
  });

  it("阻塞超时发送 heartbeat，客户端取消后释放 Reader", async () => {
    const generationId = await createGeneration();
    const baseReader = createReader();
    const close = vi.fn(() => baseReader.close());
    const stream = await openGenerationEventStreamForOwner(
      ownerId,
      generationId,
      undefined,
      {
        ...dependencies(10),
        createReader: () => ({
          read: (input) => baseReader.read(input),
          readBlocking: (input) => baseReader.readBlocking(input),
          close,
        }),
      },
    );
    const reader = stream!.getReader();

    await expect(readFrame(reader)).resolves.toBe(": keep-alive\n\n");
    await reader.cancel();
    expect(close).toHaveBeenCalledOnce();
  });
});
