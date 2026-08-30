import {
  createRedisGenerationCancellationPublisher,
  createRedisGenerationEventWriter,
  type RedisGenerationCancellationPublisher,
  type RedisGenerationEventWriter,
} from "@ai-chat/event-store";

let cancellationPublisher:
  | RedisGenerationCancellationPublisher
  | undefined;
let eventWriter: RedisGenerationEventWriter | undefined;

function requireRedisUrl(): string {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    throw new Error("缺少 REDIS_URL，无法取消 Generation");
  }

  return redisUrl;
}

export function getGenerationCancellationInfrastructure() {
  const redisUrl = requireRedisUrl();
  cancellationPublisher ??= createRedisGenerationCancellationPublisher({
    redisUrl,
  });
  eventWriter ??= createRedisGenerationEventWriter({ redisUrl });

  return { cancellationPublisher, eventWriter };
}

export async function closeGenerationCancellationInfrastructure(): Promise<void> {
  await Promise.all([cancellationPublisher?.close(), eventWriter?.close()]);
  cancellationPublisher = undefined;
  eventWriter = undefined;
}
