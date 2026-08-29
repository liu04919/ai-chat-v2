import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import { GENERATION_JOB_NAME } from "@ai-chat/contracts";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createBullMqGenerationQueueProducer,
  type BullMqGenerationQueueProducer,
} from "./generation-queue";

const localEnvironment = fileURLToPath(
  new URL("../../.env.local", import.meta.url),
);

if (existsSync(localEnvironment)) {
  loadEnvFile(localEnvironment);
}

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6380";
const queueName = `generation-queue-integration-${randomUUID()}`;
const inspectorConnection = new IORedis(redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
const inspector = new Queue(queueName, {
  connection: inspectorConnection,
});
let producer: BullMqGenerationQueueProducer;

beforeAll(() => {
  producer = createBullMqGenerationQueueProducer({ redisUrl, queueName });
});

afterAll(async () => {
  await inspector.obliterate({ force: true });
  await inspector.close();
  inspectorConnection.disconnect();
  await producer.close();
});

describe("BullMQ Generation queue", () => {
  it("使用 generationId 作为 jobId，并对重复入队去重", async () => {
    const generationId = `generation-queue-${randomUUID()}`;

    await producer.enqueue({ generationId });
    await producer.enqueue({ generationId });

    await expect(inspector.getJob(generationId)).resolves.toMatchObject({
      id: generationId,
      name: GENERATION_JOB_NAME,
      data: { generationId },
      opts: { attempts: 1 },
    });
    expect(
      (await inspector.getJobs()).filter((job) => job.id === generationId),
    ).toHaveLength(1);
  });
});
