import {
  GENERATION_JOB_NAME,
  GENERATION_QUEUE_NAME,
  generationJobPayloadSchema,
  type GenerationJobPayload,
} from "@ai-chat/contracts";
import { Worker } from "bullmq";
import IORedis from "ioredis";

export const GENERATION_WORKER_CONCURRENCY = 1;

export type GenerationJobProcessor = (
  generationId: string,
) => Promise<unknown>;

export type BullMqGenerationWorker = {
  waitUntilReady(): Promise<void>;
  close(): Promise<void>;
};

export function createBullMqGenerationWorker(input: {
  redisUrl: string;
  processGeneration: GenerationJobProcessor;
  queueName?: string;
  concurrency?: number;
}): BullMqGenerationWorker {
  const connection = new IORedis(input.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
  });
  connection.on("error", () => {
    // BullMQ Worker 的 failed/error 监听器负责记录运行时故障。
  });
  const worker = new Worker<GenerationJobPayload>(
    input.queueName ?? GENERATION_QUEUE_NAME,
    async (job) => {
      if (job.name !== GENERATION_JOB_NAME) {
        throw new Error(`不支持的 Generation job: ${job.name}`);
      }

      const payload = generationJobPayloadSchema.parse(job.data);
      return input.processGeneration(payload.generationId);
    },
    {
      connection,
      concurrency: input.concurrency ?? GENERATION_WORKER_CONCURRENCY,
    },
  );

  worker.on("error", (error) => {
    console.error("Generation Worker 运行时错误", error);
  });
  worker.on("failed", (job, error) => {
    console.error(`Generation job ${job?.id ?? "unknown"} 执行失败`, error);
  });

  return {
    waitUntilReady: () => worker.waitUntilReady(),
    async close() {
      await worker.close();

      if (connection.status !== "end") {
        connection.disconnect();
      }
    },
  };
}
