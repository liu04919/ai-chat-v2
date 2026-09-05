import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDatabase,
  createKnowledgeRepository,
  migrateDatabase,
} from "@ai-chat/db";
import { loadIntegrationTestEnvironment } from "../../../../packages/db/src/test-environment";
import { ingestKnowledge } from "./ingest";
import { retrieveKnowledge } from "./retrieve";
import { Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";
import { createKnowledgeWorker } from "./queue";

const databaseUrl = loadIntegrationTestEnvironment();
const database = createDatabase(databaseUrl, 3);
const repository = createKnowledgeRepository(database.db);
const ownerId = randomUUID();
const vector = [1, ...Array<number>(1023).fill(0)];
const embedder = {
  model: "test-embedding",
  embed: async (texts: string[]) => texts.map(() => vector),
};
let baseId: string;
beforeAll(async () => {
  await migrateDatabase({
    databaseUrl,
    migrationsFolder: fileURLToPath(
      new URL("../../../../packages/db/drizzle", import.meta.url),
    ),
  });
  await database.client`INSERT INTO "user" (id, name, email) VALUES (${ownerId}, 'RAG test', ${ownerId + "@example.com"})`;
  baseId = (await repository.createBase(ownerId, "测试知识库")).id;
});
afterAll(async () => {
  await database.client`DELETE FROM "user" WHERE id = ${ownerId}`;
  await database.close();
});

async function document(text: string, base = baseId) {
  const bytes = new TextEncoder().encode(text);
  const record = await repository.createDocument(ownerId, base, {
    originalName: "database.md",
    mediaType: "text/markdown",
    sizeBytes: bytes.length,
    objectKey: `test/${randomUUID()}`,
  });
  return { record, storage: { readObject: async () => bytes } };
}

describe("知识库入库与真实 PostgreSQL 混合检索", () => {
  it("BullMQ 消费独立入库任务并发布文档", async () => {
    const name = `knowledge-test-${randomUUID()}`;
    const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6380";
    const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    const queue = new Queue(name, { connection });
    const events = new QueueEvents(name, { connection });
    const { record, storage } = await document("队列入库文档");
    const worker = createKnowledgeWorker(
      redisUrl,
      (id) =>
        ingestKnowledge(id, {
          repository,
          storage,
          createEmbedder: () => embedder,
        }),
      name,
    );
    try {
      await events.waitUntilReady();
      await worker.waitUntilReady();
      const job = await queue.add(
        "ingest",
        { documentId: record.id },
        { jobId: record.id, attempts: 1 },
      );
      await job.waitUntilFinished(events, 10_000);
      expect(
        (await repository.listDocuments(ownerId, baseId)).find(
          (d) => d.id === record.id,
        )?.status,
      ).toBe("ready");
      await repository.deleteDocument(ownerId, baseId, record.id);
    } finally {
      await worker.close();
      await events.close();
      await queue.obliterate();
      await queue.close();
      connection.disconnect();
    }
  });
  it("pending 不可检索，成功后两路召回同一个 chunk，重复消费无副作用", async () => {
    const { record, storage } =
      await document("数据库支持向量检索和中文搜索。");
    const before = await repository.retrieve(
      ownerId,
      baseId,
      "数据库",
      vector,
      embedder.model,
    );
    expect(before.semantic).toHaveLength(0);
    await ingestKnowledge(record.id, {
      repository,
      storage,
      createEmbedder: () => embedder,
    });
    await ingestKnowledge(record.id, {
      repository,
      storage,
      createEmbedder: () => {
        throw new Error("不应再次调用");
      },
    });
    const result = await repository.retrieve(
      ownerId,
      baseId,
      "数据库",
      vector,
      embedder.model,
    );
    expect(result.semantic).toHaveLength(1);
    expect(result.lexical).toHaveLength(1);
    expect(result.lexical[0]?.id).toBe(result.semantic[0]?.id);
    const fused = await retrieveKnowledge(ownerId, baseId, "数据库", {
      repository,
      embedder,
    });
    expect(fused).toHaveLength(1);
    expect(fused[0]?.originalName).toBe("database.md");
  });
  it("另一个用户不能检索或上传，不同知识库和模型不混用", async () => {
    const embed = vi.fn(embedder.embed);
    await expect(
      retrieveKnowledge("other-user", baseId, "数据库", {
        repository,
        embedder: { ...embedder, embed },
      }),
    ).rejects.toThrow("KNOWLEDGE_NOT_FOUND");
    expect(embed).not.toHaveBeenCalled();
    await expect(
      repository.createDocument("other-user", baseId, {
        originalName: "x",
        mediaType: "text/plain",
        sizeBytes: 1,
        objectKey: "x",
      }),
    ).rejects.toThrow("KNOWLEDGE_NOT_FOUND");
    const otherBase = await repository.createBase(ownerId, "空知识库");
    expect(
      (
        await repository.retrieve(
          ownerId,
          otherBase.id,
          "数据库",
          vector,
          embedder.model,
        )
      ).semantic,
    ).toHaveLength(0);
    expect(
      (
        await repository.retrieve(
          ownerId,
          baseId,
          "数据库",
          vector,
          "different-model",
        )
      ).semantic,
    ).toHaveLength(0);
  });
  it("Embedding 失败不写入半成品，状态明确失败且不保存上游原文", async () => {
    const { record, storage } = await document("失败文档");
    await expect(
      ingestKnowledge(record.id, {
        repository,
        storage,
        createEmbedder: () => ({
          ...embedder,
          embed: async () => {
            throw new Error("secret upstream response");
          },
        }),
      }),
    ).rejects.toThrow("INGESTION_FAILED");
    const documents = await repository.listDocuments(ownerId, baseId);
    expect(documents.find((d) => d.id === record.id)).toMatchObject({
      status: "failed",
      chunkCount: 0,
      errorCode: "INGESTION_FAILED",
    });
    const chunks =
      await database.client`SELECT id FROM knowledge_chunks WHERE document_id = ${record.id}`;
    expect(chunks).toHaveLength(0);
  });
  it("发布写入中途报错时，整个批次回滚", async () => {
    const { record } = await document("原子性");
    await repository.claim(record.id);
    const chunks = Array.from({ length: 51 }, (_, i) => ({
      content: "数据库",
      page: 1,
      start: i,
      end: i + 1,
    }));
    chunks[50]!.page = 1.5;
    await expect(
      repository.publish(
        record.id,
        embedder.model,
        chunks,
        chunks.map(() => vector),
      ),
    ).rejects.toThrow();
    expect(
      await database.client`SELECT id FROM knowledge_chunks WHERE document_id = ${record.id}`,
    ).toHaveLength(0);
  });
  it("处理中删除不会复活，已完成文档删除后两路都不可检索", async () => {
    const { record } = await document("已删除");
    await repository.claim(record.id);
    await repository.deleteDocument(ownerId, baseId, record.id);
    expect(
      await repository.publish(
        record.id,
        embedder.model,
        [{ content: "x", page: 1, start: 0, end: 1 }],
        [vector],
      ),
    ).toBe(false);
    for (const doc of await repository.listDocuments(ownerId, baseId))
      await repository.deleteDocument(ownerId, baseId, doc.id);
    const result = await repository.retrieve(
      ownerId,
      baseId,
      "数据库",
      vector,
      embedder.model,
    );
    expect(result.semantic).toHaveLength(0);
    expect(result.lexical).toHaveLength(0);
  });
});
