import { closeApplicationDatabase } from "@ai-chat/db";
import {
  createRedisGenerationCancellationSubscriber,
  createRedisGenerationEventWriter,
} from "@ai-chat/event-store";
import { createConfiguredMcpServerRegistry } from "@ai-chat/mcp";
import { createR2ObjectStorage } from "@ai-chat/storage";

import { createBullMqGenerationWorker } from "./generation/bullmq-generation-worker";
import { executeGeneration } from "./generation/execute-generation";
import { createCatApiChatModel } from "./llm/cat-api-chat-model";
import { createCatApiImageModel } from "./llm/cat-api-image-model";
import type { ImageModel } from "./llm/image-model";
import { createGenerationToolResolver } from "./tools";

function requireEnvironment(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`缺少环境变量 ${name}`);
  }

  return value;
}

requireEnvironment("DATABASE_URL");
const redisUrl = requireEnvironment("REDIS_URL");
const cancellationSubscriber = createRedisGenerationCancellationSubscriber({
  redisUrl,
});
const eventWriter = createRedisGenerationEventWriter({ redisUrl });
const objectStorage = createR2ObjectStorage({
  endpoint: requireEnvironment("R2_ENDPOINT"),
  bucket: requireEnvironment("R2_BUCKET"),
  accessKeyId: requireEnvironment("R2_ACCESS_KEY_ID"),
  secretAccessKey: requireEnvironment("R2_SECRET_ACCESS_KEY"),
});
const chatModel = createCatApiChatModel({
  baseUrl: requireEnvironment("LLM_BASE_URL"),
  apiKey: requireEnvironment("LLM_API_KEY"),
  modelId: requireEnvironment("LLM_MODEL"),
});
const toolResolver = createGenerationToolResolver({
  registry: createConfiguredMcpServerRegistry(process.env),
  tavilyApiKey: process.env.TAVILY_API_KEY,
});
// 图片渠道使用独立凭证；尚未配置时只让图片任务明确失败，不影响 Chat。
const imageModel: ImageModel = {
  generate(request) {
    return createCatApiImageModel({
      baseUrl: requireEnvironment("IMAGE_BASE_URL"),
      apiKey: requireEnvironment("IMAGE_API_KEY"),
      modelId: requireEnvironment("IMAGE_MODEL"),
    }).generate(request);
  },
};
const worker = createBullMqGenerationWorker({
  redisUrl,
  processGeneration: (generationId) =>
    executeGeneration(generationId, {
      chatModel,
      imageModel,
      cancellationSubscriber,
      eventWriter,
      objectStorage,
      toolResolver,
    }),
});

let shutdownPromise: Promise<void> | undefined;

function shutdown(signal: NodeJS.Signals): Promise<void> {
  shutdownPromise ??= (async () => {
    console.info(`收到 ${signal}，正在停止 Generation Worker`);
    await worker.close();
    await cancellationSubscriber.close();
    await eventWriter.close();
    await closeApplicationDatabase();
  })();

  return shutdownPromise;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error("Generation Worker 停止失败", error);
        process.exit(1);
      });
  });
}

await worker.waitUntilReady();
console.info("@ai-chat/worker 已开始消费 Generation job（concurrency=1）");
