import { randomUUID } from "node:crypto";

import IORedis from "ioredis";
import { afterAll, describe, expect, it } from "vitest";

import {
  createRedisGenerationEventStore,
  type RedisGenerationEventStore,
} from "./redis-generation-event-store";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6380";
const keyPrefix = `generation-event-integration-${randomUUID()}`;
const inspector = new IORedis(redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
const store: RedisGenerationEventStore = createRedisGenerationEventStore({
  redisUrl,
  keyPrefix,
  ttlSeconds: 60,
});
const streamKeys = new Set<string>();

function keyFor(generationId: string): string {
  const key = `${keyPrefix}:${generationId}:events`;
  streamKeys.add(key);
  return key;
}

afterAll(async () => {
  if (streamKeys.size > 0) {
    await inspector.del(...streamKeys);
  }

  if (inspector.status === "wait") {
    inspector.disconnect();
  } else {
    await inspector.quit();
  }

  await store.close();
});

describe("Redis GenerationEvent store", () => {
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

    for (const event of events) {
      cursors.push(await store.append(event));
    }

    await expect(store.read({ generationId, limit: 2 })).resolves.toEqual([
      { cursor: cursors[0], event: events[0] },
      { cursor: cursors[1], event: events[1] },
    ]);
    await expect(
      store.read({ generationId, afterCursor: cursors[1], limit: 10 }),
    ).resolves.toEqual([
      { cursor: cursors[2], event: events[2] },
      { cursor: cursors[3], event: events[3] },
    ]);
    await expect(
      store.read({ generationId, afterCursor: cursors[3] }),
    ).resolves.toEqual([]);
  });

  it("每次 append 都刷新 Stream TTL", async () => {
    const generationId = `generation-${randomUUID()}`;
    const key = keyFor(generationId);

    await store.append({ type: "generation.started", generationId });
    await inspector.expire(key, 1);
    await store.append({
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

    await inspector.xadd(key, "*", "event", "not-json");

    await expect(store.read({ generationId })).rejects.toThrow();
  });
});
