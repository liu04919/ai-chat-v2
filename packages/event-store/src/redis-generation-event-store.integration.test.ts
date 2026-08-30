import { randomUUID } from "node:crypto";

import IORedis from "ioredis";
import { afterAll, describe, expect, it } from "vitest";

import {
  createRedisGenerationCancellationPublisher,
  createRedisGenerationCancellationSubscriber,
} from "./redis-generation-cancellation";
import {
  createRedisGenerationEventReader,
  createRedisGenerationEventWriter,
  type GenerationEventReader,
  type RedisGenerationEventWriter,
} from "./redis-generation-event-store";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6380";
const keyPrefix = `generation-event-integration-${randomUUID()}`;
const inspector = new IORedis(redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
const writer: RedisGenerationEventWriter = createRedisGenerationEventWriter({
  redisUrl,
  keyPrefix,
  ttlSeconds: 60,
});
const streamKeys = new Set<string>();
const readers = new Set<GenerationEventReader>();

function createReader(): GenerationEventReader {
  const reader = createRedisGenerationEventReader({ redisUrl, keyPrefix });
  readers.add(reader);
  return reader;
}

function keyFor(generationId: string): string {
  const key = `${keyPrefix}:${generationId}:events`;
  streamKeys.add(key);
  return key;
}

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

  await writer.close();
});

describe("Redis GenerationEvent writer and reader", () => {
  it("保持事件顺序，并从 cursor 之后继续读取", async () => {
    const generationId = `generation-${randomUUID()}`;
    keyFor(generationId);
    const events = [
      { type: "generation.started", generationId } as const,
      {
        type: "reasoning.delta",
        generationId,
        partId: "reasoning-1",
        delta: "先分析",
      } as const,
      {
        type: "text.delta",
        generationId,
        partId: "text-1",
        delta: "你好",
      } as const,
      { type: "generation.completed", generationId } as const,
    ];
    const cursors = [];
    const reader = createReader();

    for (const event of events) {
      cursors.push(await writer.append(event));
    }

    await expect(reader.read({ generationId, limit: 2 })).resolves.toEqual([
      { cursor: cursors[0], event: events[0] },
      { cursor: cursors[1], event: events[1] },
    ]);
    await expect(
      reader.read({ generationId, afterCursor: cursors[1], limit: 10 }),
    ).resolves.toEqual([
      { cursor: cursors[2], event: events[2] },
      { cursor: cursors[3], event: events[3] },
    ]);
    await expect(
      reader.read({ generationId, afterCursor: cursors[3] }),
    ).resolves.toEqual([]);
  });

  it("每次 append 都刷新 Stream TTL", async () => {
    const generationId = `generation-${randomUUID()}`;
    const key = keyFor(generationId);

    await writer.append({ type: "generation.started", generationId });
    await inspector.expire(key, 1);
    await writer.append({
      type: "text.delta",
      generationId,
      partId: "text-1",
      delta: "继续",
    });

    expect(await inspector.ttl(key)).toBeGreaterThan(50);
  });

  it("读取时拒绝不符合 GenerationEvent contract 的数据", async () => {
    const generationId = `generation-${randomUUID()}`;
    const key = keyFor(generationId);
    const reader = createReader();

    await inspector.xadd(key, "*", "event", "not-json");

    await expect(reader.read({ generationId })).rejects.toThrow();
  });

  it("使用独立连接阻塞等待 cursor 后的新事件", async () => {
    const generationId = `generation-${randomUUID()}`;
    keyFor(generationId);
    const reader = createReader();
    const startedCursor = await writer.append({
      type: "generation.started",
      generationId,
    });
    const waiting = reader.readBlocking({
      generationId,
      afterCursor: startedCursor,
      blockMs: 2_000,
    });
    const completed = { type: "generation.completed", generationId } as const;
    const completedCursor = await writer.append(completed);

    await expect(waiting).resolves.toEqual([
      { cursor: completedCursor, event: completed },
    ]);
  });

  it("阻塞超时返回空数组", async () => {
    const generationId = `generation-${randomUUID()}`;
    keyFor(generationId);
    const reader = createReader();

    await expect(
      reader.readBlocking({
        generationId,
        afterCursor: "0-0",
        blockMs: 10,
      }),
    ).resolves.toEqual([]);
  });
});

describe("Redis Generation cancellation Pub/Sub", () => {
  it("订阅建立后把指定 Generation 的取消信号交给 Worker", async () => {
    const channelPrefix = `generation-cancellation-${randomUUID()}`;
    const generationId = `generation-${randomUUID()}`;
    const publisher = createRedisGenerationCancellationPublisher({
      redisUrl,
      channelPrefix,
    });
    const subscriber = createRedisGenerationCancellationSubscriber({
      redisUrl,
      channelPrefix,
    });
    let notifyCancellation: (() => void) | undefined;
    const received = new Promise<void>((resolve) => {
      notifyCancellation = resolve;
    });
    const unsubscribe = await subscriber.subscribe(
      generationId,
      notifyCancellation!,
    );

    await publisher.publish(generationId);
    await expect(received).resolves.toBeUndefined();
    await unsubscribe();
    await Promise.all([subscriber.close(), publisher.close()]);
  });
});
