import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import { closeApplicationDatabase } from "@ai-chat/db";
import { createRedisGenerationEventStore } from "@ai-chat/event-store";
import { createR2ObjectStorage } from "@ai-chat/storage";

import { createBullMqGenerationWorker } from "./generation/bullmq-generation-worker";
import { executeChatGeneration } from "./generation/execute-chat-generation";
import { createCatApiChatModel } from "./llm/cat-api-chat-model";

const localEnvironment = fileURLToPath(
  new URL("../.env.local", import.meta.url),
);

if (existsSync(localEnvironment)) {
  loadEnvFile(localEnvironment);
}

function requireEnvironment(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`缺少 ${name}，Worker 无法启动`);
  }

  return value;
}

requireEnvironment("DATABASE_URL");
const redisUrl = requireEnvironment("REDIS_URL");
const eventStore = createRedisGenerationEventStore({ redisUrl });
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
const worker = createBullMqGenerationWorker({
  redisUrl,
  processGeneration: (generationId) =>
    executeChatGeneration(generationId, {
      chatModel,
      eventStore,
      objectStorage,
    }),
});

let shutdownPromise: Promise<void> | undefined;

function shutdown(signal: NodeJS.Signals): Promise<void> {
  shutdownPromise ??= (async () => {
    console.info(`收到 ${signal}，正在停止 Generation Worker`);
    await worker.close();
    await eventStore.close();
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
