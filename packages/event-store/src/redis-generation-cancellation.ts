import IORedis from "ioredis";

const DEFAULT_CHANNEL_PREFIX = "generation";

export interface GenerationCancellationPublisher {
  publish(generationId: string): Promise<void>;
}

export type RedisGenerationCancellationPublisher =
  GenerationCancellationPublisher & {
    close(): Promise<void>;
  };

export interface GenerationCancellationSubscriber {
  subscribe(
    generationId: string,
    onCancellation: () => void,
  ): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export type RedisGenerationCancellationConfig = {
  redisUrl: string;
  channelPrefix?: string;
};

function assertNonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} 不能为空`);
  }

  return value;
}

function cancellationChannel(prefix: string, generationId: string): string {
  return `${prefix}:${generationId}:cancel`;
}

async function closeConnection(connection: IORedis): Promise<void> {
  if (connection.status === "end") {
    return;
  }

  if (connection.status === "wait") {
    connection.disconnect();
    return;
  }

  await connection.quit();
}

export function createRedisGenerationCancellationPublisher(
  config: RedisGenerationCancellationConfig,
): RedisGenerationCancellationPublisher {
  const channelPrefix = assertNonEmpty(
    config.channelPrefix ?? DEFAULT_CHANNEL_PREFIX,
    "channelPrefix",
  );
  const connection = new IORedis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  connection.on("error", () => {
    // publish 的调用方负责处理失败；数据库中的取消请求仍是 durable state。
  });

  return {
    async publish(generationId) {
      await connection.publish(
        cancellationChannel(
          channelPrefix,
          assertNonEmpty(generationId, "generationId"),
        ),
        generationId,
      );
    },
    close: () => closeConnection(connection),
  };
}

export function createRedisGenerationCancellationSubscriber(
  config: RedisGenerationCancellationConfig,
): GenerationCancellationSubscriber {
  const channelPrefix = assertNonEmpty(
    config.channelPrefix ?? DEFAULT_CHANNEL_PREFIX,
    "channelPrefix",
  );
  const connection = new IORedis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  const listeners = new Map<string, Set<() => void>>();
  let closed = false;

  connection.on("error", () => {
    // 订阅建立失败由 subscribe 抛出；运行时故障不应让 Worker 进程崩溃。
  });
  connection.on("message", (channel) => {
    for (const listener of listeners.get(channel) ?? []) {
      listener();
    }
  });

  return {
    async subscribe(generationId, onCancellation) {
      if (closed) {
        throw new Error("Generation cancellation subscriber 已关闭");
      }

      const channel = cancellationChannel(
        channelPrefix,
        assertNonEmpty(generationId, "generationId"),
      );
      const channelListeners = listeners.get(channel) ?? new Set();
      const needsRedisSubscription = channelListeners.size === 0;
      channelListeners.add(onCancellation);
      listeners.set(channel, channelListeners);

      try {
        if (needsRedisSubscription) {
          await connection.subscribe(channel);
        }
      } catch (error) {
        channelListeners.delete(onCancellation);
        if (channelListeners.size === 0) {
          listeners.delete(channel);
        }
        throw error;
      }

      let unsubscribed = false;

      return async () => {
        if (unsubscribed) {
          return;
        }

        unsubscribed = true;
        const currentListeners = listeners.get(channel);
        currentListeners?.delete(onCancellation);

        if (currentListeners?.size === 0) {
          listeners.delete(channel);
          if (!closed) {
            await connection.unsubscribe(channel);
          }
        }
      };
    },

    async close() {
      if (closed) {
        return;
      }

      closed = true;
      listeners.clear();
      await closeConnection(connection);
    },
  };
}
