import {
  GENERATION_JOB_NAME,
  GENERATION_QUEUE_NAME,
  generationJobPayloadSchema,
  type GenerationJobPayload,
} from "@ai-chat/contracts";
import { Queue } from "bullmq";
import IORedis from "ioredis";

import type { GenerationQueueProducer } from "./generations";

export type BullMqGenerationQueueProducer = GenerationQueueProducer & {
  close(): Promise<void>;
};

export function createBullMqGenerationQueueProducer(input: {
  redisUrl: string;
  queueName?: string;
}): BullMqGenerationQueueProducer {
  const connection = new IORedis(input.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  connection.on("error", () => {
    // enqueue 的调用方负责把连接失败转换为稳定的 API 错误。
  });
  const queue = new Queue<GenerationJobPayload>(
    input.queueName ?? GENERATION_QUEUE_NAME,
    {
      connection,
    },
  );

  queue.on("error", () => {
    // enqueue 的调用方负责把连接失败转换为稳定的 API 错误。
  });

  return {
    async enqueue(payload) {
      const job = generationJobPayloadSchema.parse(payload);

      await queue.add(GENERATION_JOB_NAME, job, {
        jobId: job.generationId,
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 1000 },
      });
    },
    async close() {
      await queue.close();

      if (connection.status !== "end") {
        connection.disconnect();
      }
    },
  };
}

let applicationGenerationQueue: BullMqGenerationQueueProducer | undefined;

export function getGenerationQueueProducer(): GenerationQueueProducer {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    throw new Error("缺少 REDIS_URL，无法连接 Generation Queue");
  }

  applicationGenerationQueue ??= createBullMqGenerationQueueProducer({
    redisUrl,
  });
  return applicationGenerationQueue;
}

export async function closeGenerationQueueProducer(): Promise<void> {
  await applicationGenerationQueue?.close();
  applicationGenerationQueue = undefined;
}
