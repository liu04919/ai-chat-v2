import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import {
  GENERATION_JOB_NAME,
  type UserMessagePartsDto,
} from "@ai-chat/contracts";
import {
  attachments,
  closeApplicationDatabase,
  createDatabase,
  createGenerationCommandRecord,
  migrateDatabase,
  requestGenerationCancellationForOwner,
  user,
} from "@ai-chat/db";
import {
  createRedisGenerationCancellationPublisher,
  createRedisGenerationCancellationSubscriber,
  createRedisGenerationEventReader,
  createRedisGenerationEventWriter,
} from "@ai-chat/event-store";
import { Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ImageModelRequest } from "../llm/image-model";
import { createBullMqGenerationWorker } from "./bullmq-generation-worker";
import {
  executeGeneration,
  type ExecuteGenerationDependencies,
} from "./execute-generation";

const envPath = fileURLToPath(
  new URL("../../../web/.env.local", import.meta.url),
);
if (existsSync(envPath)) loadEnvFile(envPath);
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("缺少 TEST_DATABASE_URL");
process.env.DATABASE_URL = databaseUrl;

const database = createDatabase(databaseUrl, 1);
const ownerId = `image-owner-${randomUUID()}`;
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6380";
const keyPrefix = `image-events-${randomUUID()}`;
const channelPrefix = `image-cancel-${randomUUID()}`;
const eventWriter = createRedisGenerationEventWriter({
  redisUrl,
  keyPrefix,
  ttlSeconds: 60,
});
const eventReader = createRedisGenerationEventReader({ redisUrl, keyPrefix });
const cancellationSubscriber = createRedisGenerationCancellationSubscriber({
  redisUrl,
  channelPrefix,
});
const cancellationPublisher = createRedisGenerationCancellationPublisher({
  redisUrl,
  channelPrefix,
});
const queueName = `image-worker-${randomUUID()}`;
const queueConnection = new IORedis(redisUrl, { maxRetriesPerRequest: 1 });
const eventConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue(queueName, { connection: queueConnection });
const queueEvents = new QueueEvents(queueName, { connection: eventConnection });
const queuedDependencies = new Map<string, ExecuteGenerationDependencies>();
const worker = createBullMqGenerationWorker({
  redisUrl,
  queueName,
  processGeneration: (id) => {
    const dependencies = queuedDependencies.get(id);
    if (!dependencies) throw new Error("未设置测试依赖");
    return executeGeneration(id, dependencies);
  },
});
const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHZkAAAAASUVORK5CYII=",
    "base64",
  ),
);

function fixture() {
  const objects = new Map<string, Uint8Array>();
  const readObject = vi.fn(async (key: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const data = objects.get(key);
    if (!data) throw new Error("missing object");
    return data;
  });
  const writeObject = vi.fn(
    async (
      input: Parameters<
        ExecuteGenerationDependencies["objectStorage"]["writeObject"]
      >[0],
    ) => {
      input.abortSignal?.throwIfAborted();
      objects.set(input.objectKey, input.data);
    },
  );
  const deleteObject = vi.fn(async (key: string) => {
    objects.delete(key);
  });
  const generate = vi.fn(async (request: ImageModelRequest) => {
    request.abortSignal?.throwIfAborted();
    return { data: png, mediaType: "image/png" };
  });
  const dependencies: ExecuteGenerationDependencies = {
    chatModel: {
      stream() {
        throw new Error("Image 不应进入 Chat Model");
      },
    },
    imageModel: { generate },
    eventWriter,
    cancellationSubscriber,
    objectStorage: {
      readObject,
      writeObject,
      deleteObject,
      createDownloadUrl: async () => {
        throw new Error("Image 不使用下载签名 URL");
      },
    },
  };
  return {
    dependencies,
    objects,
    generate,
    readObject,
    writeObject,
    deleteObject,
  };
}

async function createGeneration(
  existingConversationId?: string,
  parts: UserMessagePartsDto = [{ type: "text", text: "画一只蓝色猫" }],
) {
  const generationId = randomUUID();
  const conversationId = existingConversationId ?? randomUUID();
  const userMessageId = randomUUID();
  const result = await createGenerationCommandRecord(
    {
      generationId,
      ownerId,
      userMessageId,
      parts,
      target: existingConversationId
        ? { type: "existing", conversationId }
        : { type: "new", conversationId, mode: "image" },
      reasoningEffort: null,
      conversationTitle: "图片测试",
      now: new Date(),
    },
    database.db,
  );
  expect(result.kind).toBe("created");
  return { generationId, conversationId, userMessageId };
}

function getGeneration(id: string) {
  return database.db.query.generations.findFirst({
    where: (table, { eq }) => eq(table.id, id),
  });
}

async function eventTypes(generationId: string) {
  return (await eventReader.read({ generationId })).map(
    (entry) => entry.event.type,
  );
}

async function cancel(generationId: string) {
  await requestGenerationCancellationForOwner(
    { ownerId, generationId, now: new Date() },
    database.db,
  );
  await cancellationPublisher.publish(generationId);
}

beforeAll(async () => {
  await migrateDatabase({
    databaseUrl,
    migrationsFolder: fileURLToPath(
      new URL("../../../../packages/db/drizzle", import.meta.url),
    ),
  });
  await database.db
    .insert(user)
    .values({
      id: ownerId,
      name: "Image test",
      email: `${ownerId}@example.com`,
    });
  await Promise.all([worker.waitUntilReady(), queueEvents.waitUntilReady()]);
});

afterAll(async () => {
  await worker.close();
  await queue.obliterate({ force: true });
  await queueEvents.close();
  await queue.close();
  queueConnection.disconnect();
  eventConnection.disconnect();
  await eventReader.close();
  await eventWriter.close();
  await cancellationPublisher.close();
  await cancellationSubscriber.close();
  await database.client`DELETE FROM "user" WHERE id = ${ownerId}`;
  await database.close();
  await closeApplicationDatabase();
});

describe("Image Generation Worker", () => {
  it("Queue → Image → 对象存储 → 附件和消息事务 → completed，重复任务跳过", async () => {
    const test = fixture();
    const { generationId, conversationId } = await createGeneration();
    queuedDependencies.set(generationId, test.dependencies);
    const job = await queue.add(
      GENERATION_JOB_NAME,
      { generationId },
      { jobId: generationId, attempts: 1 },
    );
    await expect(
      job.waitUntilFinished(queueEvents, 5000),
    ).resolves.toMatchObject({ kind: "completed" });
    const generation = await getGeneration(generationId);
    expect(generation).toMatchObject({ status: "completed", errorCode: null });
    const persistedMessages = await database.db.query.messages.findMany({
      where: (table, { eq }) => eq(table.conversationId, conversationId),
      orderBy: (table, { asc }) => asc(table.sequence),
    });
    expect(persistedMessages).toHaveLength(2);
    const part = persistedMessages[1].parts[0];
    expect(part.type).toBe("attachment");
    if (part.type !== "attachment") throw new Error("missing attachment");
    const attachment = await database.db.query.attachments.findFirst({
      where: (table, { eq }) => eq(table.id, part.attachmentId),
    });
    expect(attachment).toMatchObject({
      ownerId,
      status: "ready",
      mediaType: "image/png",
      sizeBytes: png.length,
    });
    expect(attachment?.linkedAt).toBeInstanceOf(Date);
    expect(attachment?.readyAt).toBeInstanceOf(Date);
    expect(test.objects.get(attachment!.objectKey)).toEqual(png);
    expect(persistedMessages[1].id).toBe(generation?.assistantMessageId);
    expect(await eventTypes(generationId)).toEqual([
      "generation.started",
      "generation.completed",
    ]);
    await job.remove();
    const duplicate = await queue.add(
      GENERATION_JOB_NAME,
      { generationId },
      { jobId: generationId, attempts: 1 },
    );
    await expect(
      duplicate.waitUntilFinished(queueEvents, 5000),
    ).resolves.toEqual({ kind: "skipped" });
    expect(test.generate).toHaveBeenCalledOnce();

    // 新一轮必须从 PostgreSQL 历史及自有对象存储重建请求。
    const next = await createGeneration(conversationId, [
      { type: "text", text: "背景改成红色" },
    ]);
    await executeGeneration(next.generationId, test.dependencies);
    expect(test.generate.mock.calls[1][0]).toMatchObject({
      referenceImage: png,
    });
    expect(test.generate.mock.calls[1][0].prompt).toContain("画一只蓝色猫");
    expect(test.generate.mock.calls[1][0].prompt).toContain("背景改成红色");
    expect(test.readObject).toHaveBeenCalledWith(
      attachment!.objectKey,
      expect.any(AbortSignal),
    );
  });

  it("用户本轮参考图从 R2 读取，生成后不删除原图", async () => {
    const test = fixture();
    const attachmentId = randomUUID();
    const key = `reference/${attachmentId}.png`;
    test.objects.set(key, png);
    await database.db
      .insert(attachments)
      .values({
        id: attachmentId,
        ownerId,
        objectKey: key,
        originalName: "reference.png",
        mediaType: "image/png",
        sizeBytes: png.length,
        status: "ready",
        readyAt: new Date(),
      });
    const job = await createGeneration(undefined, [
      { type: "text", text: "给参考图加帽子" },
      { type: "attachment", attachmentId },
    ]);
    await executeGeneration(job.generationId, test.dependencies);
    expect(test.generate.mock.calls[0][0].referenceImage).toEqual(png);
    expect(test.objects.has(key)).toBe(true);
    expect(test.objects.size).toBe(2);
  });

  it.each(["model", "read", "write", "metadata", "transaction"])(
    "%s 失败不发布半成品附件或消息",
    async (stage) => {
      const test = fixture();
      let parts: UserMessagePartsDto = [{ type: "text", text: "画猫" }];
      if (stage === "model")
        test.generate.mockRejectedValueOnce(new Error("model failed"));
      if (stage === "metadata")
        test.generate.mockResolvedValueOnce({
          data: new Uint8Array(),
          mediaType: "image/png",
        });
      if (stage === "write")
        test.writeObject.mockImplementationOnce(async (input) => {
          test.objects.set(input.objectKey, input.data);
          throw new Error("write failed after sending");
        });
      if (stage === "read") {
        const id = randomUUID();
        await database.db
          .insert(attachments)
          .values({
            id,
            ownerId,
            objectKey: `missing/${id}`,
            originalName: "missing.png",
            mediaType: "image/png",
            sizeBytes: 1,
            status: "ready",
            readyAt: new Date(),
          });
        parts = [...parts, { type: "attachment", attachmentId: id }];
      }
      const job = await createGeneration(undefined, parts);
      if (stage === "transaction")
        test.dependencies.createAssistantMessageId = () => job.userMessageId;
      await expect(
        executeGeneration(job.generationId, test.dependencies),
      ).rejects.toThrow();
      expect(await getGeneration(job.generationId)).toMatchObject({
        status: "failed",
        errorCode: "IMAGE_GENERATION_FAILED",
        assistantMessageId: null,
      });
      expect(await eventTypes(job.generationId)).toEqual([
        "generation.started",
        "generation.failed",
      ]);
      const messages = await database.db.query.messages.findMany({
        where: (table, { eq }) => eq(table.conversationId, job.conversationId),
      });
      expect(messages).toHaveLength(1);
      expect(test.objects.size).toBe(0);
      for (const [input] of test.writeObject.mock.calls) {
        expect(
          await database.db.query.attachments.findFirst({
            where: (table, { eq }) => eq(table.objectKey, input.objectKey),
          }),
        ).toBeUndefined();
        expect(test.deleteObject).toHaveBeenCalledWith(input.objectKey);
      }
    },
  );

  it("运行中停止：Pub/Sub 中断模型，不生成半张图消息", async () => {
    const test = fixture();
    let modelEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      modelEntered = resolve;
    });
    test.generate.mockImplementationOnce(async (request) => {
      modelEntered();
      const signal = request.abortSignal!;
      signal.throwIfAborted();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      signal.throwIfAborted();
      return { data: png, mediaType: "image/png" };
    });
    const job = await createGeneration();
    const running = executeGeneration(job.generationId, test.dependencies);
    await entered;
    await cancel(job.generationId);
    await expect(running).resolves.toEqual({
      kind: "cancelled",
      assistantMessageId: null,
    });
    expect(test.generate.mock.calls[0][0].abortSignal?.aborted).toBe(true);
    expect(test.writeObject).not.toHaveBeenCalled();
    expect(await getGeneration(job.generationId)).toMatchObject({
      status: "cancelled",
      assistantMessageId: null,
    });
    expect(await eventTypes(job.generationId)).toEqual([
      "generation.started",
      "generation.cancelled",
    ]);
  });

  it("取消在上传后、数据库发布前到达时，清理图片且不落库", async () => {
    const test = fixture();
    const job = await createGeneration();
    test.writeObject.mockImplementationOnce(async (input) => {
      test.objects.set(input.objectKey, input.data);
      // 不发送 Pub/Sub，验证数据库行锁上的取消检查也能守住边界。
      await requestGenerationCancellationForOwner(
        { ownerId, generationId: job.generationId, now: new Date() },
        database.db,
      );
    });
    await expect(
      executeGeneration(job.generationId, test.dependencies),
    ).resolves.toEqual({ kind: "cancelled", assistantMessageId: null });
    expect(test.objects.size).toBe(0);
    expect(test.deleteObject).toHaveBeenCalledOnce();
    expect(await getGeneration(job.generationId)).toMatchObject({
      status: "cancelled",
      assistantMessageId: null,
    });
  });

  it("领取前取消跳过；订阅期间取消也不会启动模型", async () => {
    const test = fixture();
    const queued = await createGeneration();
    await cancel(queued.generationId);
    await expect(
      executeGeneration(queued.generationId, test.dependencies),
    ).resolves.toEqual({ kind: "skipped" });
    const job = await createGeneration();
    test.dependencies.cancellationSubscriber = {
      close: async () => {},
      async subscribe(id, onCancel) {
        const unsubscribe = await cancellationSubscriber.subscribe(
          id,
          onCancel,
        );
        await requestGenerationCancellationForOwner(
          { ownerId, generationId: id, now: new Date() },
          database.db,
        );
        return unsubscribe;
      },
    };
    await expect(
      executeGeneration(job.generationId, test.dependencies),
    ).resolves.toMatchObject({ kind: "cancelled" });
    expect(test.generate).not.toHaveBeenCalled();
    expect(await eventTypes(job.generationId)).toEqual([
      "generation.cancelled",
    ]);
  });

  it("completed 事件发送失败仍保留已提交资产；不发布 failed", async () => {
    const test = fixture();
    const job = await createGeneration();
    test.dependencies.eventWriter = {
      async append(event) {
        if (event.type === "generation.completed")
          throw new Error("event publish failed");
        return eventWriter.append(event);
      },
    };
    await expect(
      executeGeneration(job.generationId, test.dependencies),
    ).rejects.toThrow("event publish failed");
    expect(await getGeneration(job.generationId)).toMatchObject({
      status: "completed",
    });
    expect(test.objects.size).toBe(1);
    expect(test.deleteObject).not.toHaveBeenCalled();
    expect(await eventTypes(job.generationId)).toEqual(["generation.started"]);
  });

  it("清理对象失败会报告错误，但不阻止数据库进入 failed", async () => {
    const test = fixture();
    const job = await createGeneration();
    test.dependencies.createAssistantMessageId = () => job.userMessageId;
    test.deleteObject.mockRejectedValueOnce(new Error("delete failed"));
    await expect(
      executeGeneration(job.generationId, test.dependencies),
    ).rejects.toThrow("清理未发布对象失败");
    expect(await getGeneration(job.generationId)).toMatchObject({
      status: "failed",
    });
    expect(await eventTypes(job.generationId)).toEqual([
      "generation.started",
      "generation.failed",
    ]);
  });
});
