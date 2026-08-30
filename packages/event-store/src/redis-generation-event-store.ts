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
const DEFAULT_BLOCK_MS = 15_000;
const MAX_BLOCK_MS = 60_000;

export type GenerationEventEntry = {
  cursor: GenerationEventCursor;
  event: GenerationEventDto;
};

export type ReadGenerationEventsInput = {
  generationId: string;
  afterCursor?: GenerationEventCursor;
  limit?: number;
};

export type ReadBlockingGenerationEventsInput = {
  generationId: string;
  afterCursor: GenerationEventCursor;
  limit?: number;
  blockMs?: number;
};

export interface GenerationEventWriter {
  append(event: GenerationEventDto): Promise<GenerationEventCursor>;
}

export type RedisGenerationEventWriter = GenerationEventWriter & {
  close(): Promise<void>;
};

export interface GenerationEventReader {
  read(input: ReadGenerationEventsInput): Promise<GenerationEventEntry[]>;
  readBlocking(
    input: ReadBlockingGenerationEventsInput,
  ): Promise<GenerationEventEntry[]>;
  close(): Promise<void>;
}

export type RedisGenerationEventWriterConfig = {
  redisUrl: string;
  keyPrefix?: string;
  ttlSeconds?: number;
};

export type RedisGenerationEventReaderConfig = {
  redisUrl: string;
  keyPrefix?: string;
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

function readLimit(value: number | undefined): number {
  const limit = assertPositiveInteger(value ?? DEFAULT_READ_LIMIT, "limit");

  if (limit > MAX_READ_LIMIT) {
    throw new RangeError(`limit 不能超过 ${MAX_READ_LIMIT}`);
  }

  return limit;
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

export function createRedisGenerationEventWriter(
  config: RedisGenerationEventWriterConfig,
): RedisGenerationEventWriter {
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

export function createRedisGenerationEventReader(
  config: RedisGenerationEventReaderConfig,
): GenerationEventReader {
  const keyPrefix = assertNonEmpty(
    config.keyPrefix ?? DEFAULT_KEY_PREFIX,
    "keyPrefix",
  );
  const connection = new IORedis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    autoResendUnfulfilledCommands: false,
  });
  let closed = false;

  connection.on("error", () => {
    // Reader 调用方负责处理读取失败；主动断开时错误会由 close 路径吞掉。
  });

  return {
    async read(input) {
      const generationId = assertNonEmpty(input.generationId, "generationId");
      const afterCursor = input.afterCursor
        ? generationEventCursorSchema.parse(input.afterCursor)
        : undefined;
      const entries = await connection.xrange(
        streamKey(keyPrefix, generationId),
        afterCursor ? `(${afterCursor}` : "-",
        "+",
        "COUNT",
        readLimit(input.limit),
      );

      return entries.map((entry) => parseEntry(generationId, entry));
    },

    async readBlocking(input) {
      const generationId = assertNonEmpty(input.generationId, "generationId");
      const afterCursor = generationEventCursorSchema.parse(input.afterCursor);
      const blockMs = assertPositiveInteger(
        input.blockMs ?? DEFAULT_BLOCK_MS,
        "blockMs",
      );

      if (blockMs > MAX_BLOCK_MS) {
        throw new RangeError(`blockMs 不能超过 ${MAX_BLOCK_MS}`);
      }

      const streams = await connection.xread(
        "COUNT",
        readLimit(input.limit),
        "BLOCK",
        blockMs,
        "STREAMS",
        streamKey(keyPrefix, generationId),
        afterCursor,
      );
      const entries = streams?.[0]?.[1] ?? [];

      return entries.map((entry) => parseEntry(generationId, entry));
    },

    async close() {
      if (closed) {
        return;
      }

      closed = true;
      connection.disconnect();
    },
  };
}
