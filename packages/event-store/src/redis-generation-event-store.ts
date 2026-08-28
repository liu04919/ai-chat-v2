import {
  generationEventCursorSchema,
  generationEventSchema,
  type GenerationEventCursor,
  type GenerationEventDto,
} from "@ai-chat/contracts";
import IORedis from "ioredis";

export const GENERATION_EVENT_TTL_SECONDS = 24 * 60 * 60;

const EVENT_FIELD = "event";
const DEFAULT_KEY_PREFIX = "generation";
const DEFAULT_READ_LIMIT = 100;
const MAX_READ_LIMIT = 1000;

export type GenerationEventEntry = {
  cursor: GenerationEventCursor;
  event: GenerationEventDto;
};

export type ReadGenerationEventsInput = {
  generationId: string;
  afterCursor?: GenerationEventCursor;
  limit?: number;
};

export interface GenerationEventStore {
  append(event: GenerationEventDto): Promise<GenerationEventCursor>;
  read(input: ReadGenerationEventsInput): Promise<GenerationEventEntry[]>;
}

export type RedisGenerationEventStore = GenerationEventStore & {
  close(): Promise<void>;
};

export type RedisGenerationEventStoreConfig = {
  redisUrl: string;
  keyPrefix?: string;
  ttlSeconds?: number;
};

function assertNonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} 不能为空`);
  }

  return value;
}

function assertPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} 必须是正整数`);
  }

  return value;
}

function streamKey(keyPrefix: string, generationId: string): string {
  return `${keyPrefix}:${generationId}:events`;
}

function eventPayload(fields: string[]): string {
  for (let index = 0; index < fields.length; index += 2) {
    if (fields[index] === EVENT_FIELD) {
      const payload = fields[index + 1];

      if (payload !== undefined) {
        return payload;
      }
    }
  }

  throw new Error("Redis GenerationEvent entry 缺少 event 字段");
}

function parseEntry(
  generationId: string,
  entry: [cursor: string, fields: string[]],
): GenerationEventEntry {
  const cursor = generationEventCursorSchema.parse(entry[0]);
  const event = generationEventSchema.parse(JSON.parse(eventPayload(entry[1])));

  if (event.generationId !== generationId) {
    throw new Error("Redis GenerationEvent 与 stream 的 generationId 不一致");
  }

  return { cursor, event };
}

export function createRedisGenerationEventStore(
  config: RedisGenerationEventStoreConfig,
): RedisGenerationEventStore {
  const keyPrefix = assertNonEmpty(
    config.keyPrefix ?? DEFAULT_KEY_PREFIX,
    "keyPrefix",
  );
  const ttlSeconds = assertPositiveInteger(
    config.ttlSeconds ?? GENERATION_EVENT_TTL_SECONDS,
    "ttlSeconds",
  );
  const connection = new IORedis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  connection.on("error", () => {
    // 命令调用方负责处理连接和写入失败。
  });

  return {
    async append(inputEvent) {
      const event = generationEventSchema.parse(inputEvent);
      const key = streamKey(keyPrefix, event.generationId);
      const result = await connection
        .multi()
        .xadd(key, "*", EVENT_FIELD, JSON.stringify(event))
        .expire(key, ttlSeconds)
        .exec();

      if (!result) {
        throw new Error("Redis GenerationEvent transaction 没有返回结果");
      }

      for (const [error] of result) {
        if (error) {
          throw error;
        }
      }

      return generationEventCursorSchema.parse(result[0]?.[1]);
    },

    async read(input) {
      const generationId = assertNonEmpty(input.generationId, "generationId");
      const afterCursor = input.afterCursor
        ? generationEventCursorSchema.parse(input.afterCursor)
        : undefined;
      const limit = assertPositiveInteger(
        input.limit ?? DEFAULT_READ_LIMIT,
        "limit",
      );

      if (limit > MAX_READ_LIMIT) {
        throw new RangeError(`limit 不能超过 ${MAX_READ_LIMIT}`);
      }

      const entries = await connection.xrange(
        streamKey(keyPrefix, generationId),
        afterCursor ? `(${afterCursor}` : "-",
        "+",
        "COUNT",
        limit,
      );

      return entries.map((entry) => parseEntry(generationId, entry));
    },

    async close() {
      if (connection.status === "end") {
        return;
      }

      if (connection.status === "wait") {
        connection.disconnect();
        return;
      }

      await connection.quit();
    },
  };
}
