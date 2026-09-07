import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GenerationEventDto } from "@ai-chat/contracts";
import {
  closeApplicationDatabase,
  createDatabase,
  createKnowledgeRepository,
  createGenerationCommandRecord,
  createRegenerationCommandRecord,
  createConversationShareRecordForOwner,
  getConversationShareRecordByToken,
  migrateDatabase,
  requestGenerationCancellationForOwner,
} from "@ai-chat/db";
import { loadIntegrationTestEnvironment } from "../../../../packages/db/src/test-environment";
import { ingestKnowledge } from "../../../worker/src/knowledge/ingest";
import { retrieveKnowledge } from "../../../worker/src/knowledge/retrieve";
import type { ChatKnowledgeRetriever } from "../../../worker/src/knowledge/chat-knowledge";
import {
  executeGeneration,
  type ExecuteGenerationDependencies,
} from "../../../worker/src/generation/execute-generation";
import type { ChatModelRequest } from "../../../worker/src/llm/chat-model";
import {
  deleteKnowledgeDocument,
  createKnowledgeUpload,
  completeKnowledgeUpload,
  toKnowledgeDocument,
  type KnowledgeServiceDependencies,
} from "./knowledge";
import { getConversationForOwner } from "./conversations";

const databaseUrl = loadIntegrationTestEnvironment();
process.env.DATABASE_URL = databaseUrl;
const database = createDatabase(databaseUrl, 3);
const repository = createKnowledgeRepository(database.db);
const ownerId = randomUUID();
const strangerId = randomUUID();
const objects = new Map<string, Uint8Array>();
const contentTypes = new Map<string, string>();
const queued: string[] = [];
const storage = {
  async createUploadUrl({
    objectKey,
    contentType,
  }: {
    objectKey: string;
    contentType: string;
  }) {
    return {
      method: "PUT" as const,
      url: `https://r2.test/${objectKey}`,
      headers: { "Content-Type": contentType },
    };
  },
  async headObject(key: string) {
    const data = objects.get(key);
    return data
      ? {
          sizeBytes: data.byteLength,
          contentType: contentTypes.get(key) ?? null,
        }
      : null;
  },
  async writeObject({
    objectKey,
    data,
  }: {
    objectKey: string;
    data: Uint8Array;
  }) {
    objects.set(objectKey, data);
  },
  async readObject(key: string) {
    const data = objects.get(key);
    if (!data) throw new Error("missing object");
    return data;
  },
  async deleteObject(key: string) {
    objects.delete(key);
    contentTypes.delete(key);
  },
};
const dependencies = {
  repository,
  storage,
  enqueue: async (id: string) => {
    queued.push(id);
  },
};

// 模拟浏览器直传：业务服务只接收元信息，测试自行把字节写入假 R2。
async function uploadKnowledgeDocument(
  ownerId: string,
  baseId: string,
  file: File,
  deps: KnowledgeServiceDependencies,
) {
  const upload = await createKnowledgeUpload(
    ownerId,
    baseId,
    {
      originalName: file.name,
      mediaType: file.name.endsWith(".md") ? "text/markdown" : "text/plain",
      sizeBytes: file.size,
    },
    deps,
  );
  const key = new URL(upload.upload.url).pathname.slice(1);
  objects.set(key, new Uint8Array(await file.arrayBuffer()));
  contentTypes.set(key, upload.upload.headers["Content-Type"]!);
  return completeKnowledgeUpload(ownerId, baseId, upload.document.id, deps);
}
const vector = [1, ...Array<number>(1023).fill(0)];
const embedder = {
  model: "traditional-rag-test",
  embed: async (texts: string[]) => texts.map(() => vector),
};
const reranker = {
  model: "traditional-rerank-test",
  async rerank(
    _query: string,
    candidates: import("@ai-chat/db").KnowledgeHit[],
  ) {
    return {
      hits: candidates.slice(0, 6).map((h) => ({ ...h, rerankScore: 0.9 })),
      totalTokens: 1,
      requestId: "test",
    };
  },
};
const retrieve: ChatKnowledgeRetriever = async ({
  ownerId,
  baseId,
  query,
  signal,
}) => {
  const hits = await retrieveKnowledge(ownerId, baseId, query, {
    repository,
    embedder,
    reranker,
    signal,
  });
  return hits.map((h, i) => ({
    number: i + 1,
    chunkId: h.id,
    documentId: h.documentId,
    originalName: h.originalName,
    page: h.page,
    content: h.content,
  }));
};

beforeAll(async () => {
  await migrateDatabase({
    databaseUrl,
    migrationsFolder: fileURLToPath(
      new URL("../../../../packages/db/drizzle", import.meta.url),
    ),
  });
  for (const id of [ownerId, strangerId]) {
    await database.client`INSERT INTO "user" (id, name, email) VALUES (${id}, 'Traditional RAG test', ${id + "@example.com"})`;
  }
});
afterAll(async () => {
  for (const id of [ownerId, strangerId])
    await database.client`DELETE FROM "user" WHERE id = ${id}`;
  await database.close();
  await closeApplicationDatabase();
});

function command(
  baseId: string | null,
  conversationId = randomUUID(),
  existing = false,
) {
  return {
    ownerId,
    generationId: randomUUID(),
    userMessageId: randomUUID(),
    target: existing
      ? { type: "existing" as const, conversationId }
      : { type: "new" as const, conversationId, mode: "chat" as const },
    parts: [{ type: "text" as const, text: "向量检索如何工作？" }],
    reasoningEffort: "medium" as const,
    tools: { webSearch: false, mcpToolIds: [] },
    knowledgeBaseId: baseId,
    conversationTitle: "RAG test",
    now: new Date(),
  };
}

function execution(knowledgeRetriever: ChatKnowledgeRetriever = retrieve) {
  const requests: ChatModelRequest[] = [];
  const events: GenerationEventDto[] = [];
  let notifyCancel = () => {};
  const deps: ExecuteGenerationDependencies = {
    knowledgeRetriever,
    chatModel: {
      async *stream(request) {
        requests.push(request);
        yield {
          type: "text",
          partId: "answer",
          delta: "向量检索按语义召回。[1](#knowledge-1)",
        };
        yield { type: "finish", reason: "stop" };
      },
    },
    imageModel: {
      async generate() {
        throw new Error("图片模型不应调用");
      },
    },
    cancellationSubscriber: {
      async subscribe(_id, callback) {
        notifyCancel = callback;
        return async () => {};
      },
      async close() {},
    },
    eventWriter: {
      async append(event) {
        events.push(event);
        return `${events.length}-0`;
      },
    },
    objectStorage: {
      ...storage,
      async createDownloadUrl() {
        throw new Error("无聊天附件");
      },
    },
  };
  return { deps, requests, events, cancel: () => notifyCancel() };
}

async function readyBase() {
  const base = await repository.createBase(ownerId, "中文数据库资料");
  const file = new File(
    ["向量检索使用嵌入向量计算语义相似度，混合检索结合 BM25。"],
    "数据库.md",
  );
  const document = await uploadKnowledgeDocument(
    ownerId,
    base.id,
    file,
    dependencies,
  );
  expect(document.status).toBe("pending");
  expect(queued).toContain(document.id);
  expect(document).not.toHaveProperty("objectKey");
  await ingestKnowledge(document.id, {
    repository,
    storage,
    createEmbedder: () => embedder,
  });
  expect(
    toKnowledgeDocument((await repository.listDocuments(ownerId, base.id))[0]!)
      .status,
  ).toBe("ready");
  return { base, document };
}

describe("完整传统 RAG：上传、入库、生成和引用", () => {
  it("待上传不入队、不能被 Worker 领取；并发确认只入队一次", async () => {
    const base = await repository.createBase(ownerId, "直传状态测试");
    const enqueue = vi.fn(async () => {});
    const deps = { ...dependencies, enqueue };
    const upload = await createKnowledgeUpload(
      ownerId,
      base.id,
      {
        originalName: "资料.txt",
        mediaType: "text/plain",
        sizeBytes: 4,
      },
      deps,
    );
    expect(upload.document.status).toBe("uploading");
    expect(upload.document).not.toHaveProperty("objectKey");
    expect(upload.upload.method).toBe("PUT");
    expect(enqueue).not.toHaveBeenCalled();
    expect(await repository.claim(upload.document.id)).toBeUndefined();
    await expect(
      completeKnowledgeUpload(ownerId, base.id, upload.document.id, deps),
    ).rejects.toThrow("KNOWLEDGE_UPLOAD_NOT_FOUND");
    const key = new URL(upload.upload.url).pathname.slice(1);
    objects.set(key, new TextEncoder().encode("test"));
    contentTypes.set(key, "text/plain; charset=utf-8");
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        completeKnowledgeUpload(ownerId, base.id, upload.document.id, deps),
      ),
    );
    expect(results.every((result) => result.status === "pending")).toBe(true);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(upload.document.id);
    await ingestKnowledge(upload.document.id, {
      repository,
      storage,
      createEmbedder: () => embedder,
    });
    expect(
      (
        await completeKnowledgeUpload(
          ownerId,
          base.id,
          upload.document.id,
          deps,
        )
      ).status,
    ).toBe("ready");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("完成接口校验用户和知识库归属，不允许确认别人的文件", async () => {
    const base = await repository.createBase(ownerId, "归属测试");
    const otherBase = await repository.createBase(ownerId, "另一知识库");
    const upload = await createKnowledgeUpload(
      ownerId,
      base.id,
      {
        originalName: "x.txt",
        mediaType: "text/plain",
        sizeBytes: 4,
      },
      dependencies,
    );
    const headObject = vi.fn(storage.headObject);
    const deps = { ...dependencies, storage: { ...storage, headObject } };
    await expect(
      completeKnowledgeUpload(strangerId, base.id, upload.document.id, deps),
    ).rejects.toThrow("KNOWLEDGE_NOT_FOUND");
    await expect(
      completeKnowledgeUpload(ownerId, otherBase.id, upload.document.id, deps),
    ).rejects.toThrow("KNOWLEDGE_NOT_FOUND");
    expect(headObject).not.toHaveBeenCalled();
    await deleteKnowledgeDocument(ownerId, base.id, upload.document.id, deps);
    await expect(
      completeKnowledgeUpload(ownerId, base.id, upload.document.id, deps),
    ).rejects.toThrow("KNOWLEDGE_NOT_FOUND");
  });

  it.each([
    { sizeBytes: 5, contentType: "text/plain" },
    { sizeBytes: 4, contentType: "application/pdf" },
    { sizeBytes: null, contentType: null },
  ])("拒绝 R2 元信息不匹配且不入队：%j", async (metadata) => {
    const base = await repository.createBase(ownerId, "核验测试");
    const upload = await createKnowledgeUpload(
      ownerId,
      base.id,
      {
        originalName: "x.txt",
        mediaType: "text/plain",
        sizeBytes: 4,
      },
      dependencies,
    );
    const enqueue = vi.fn(async () => {});
    await expect(
      completeKnowledgeUpload(ownerId, base.id, upload.document.id, {
        ...dependencies,
        enqueue,
        storage: { ...storage, headObject: async () => metadata },
      }),
    ).rejects.toThrow("KNOWLEDGE_METADATA_MISMATCH");
    expect(enqueue).not.toHaveBeenCalled();
    expect(
      (await repository.getDocument(ownerId, base.id, upload.document.id))
        .status,
    ).toBe("uploading");
  });

  it.each([false, true])(
    "空库跳过工具准备并完成提示落库（配置 resolver：%s）",
    async (withResolver) => {
      const base = await repository.createBase(ownerId, "空库分支测试");
      const input = {
        ...command(base.id),
        tools: { webSearch: true, mcpToolIds: [] },
      };
      await createGenerationCommandRecord(input, database.db);
      const run = execution(async () => []);
      const resolve = vi.fn(async () => {
        throw new Error("空库不应准备工具");
      });
      if (withResolver) run.deps.toolResolver = { resolve };

      const result = await executeGeneration(input.generationId, run.deps);

      expect(result.kind).toBe("completed");
      expect(resolve).not.toHaveBeenCalled();
      expect(run.requests).toHaveLength(0);
      expect(
        run.events.find((event) => event.type === "knowledge.sources"),
      ).toMatchObject({ sources: [] });
      expect(run.events.at(-1)?.type).toBe("generation.completed");
      const detail = await getConversationForOwner(
        ownerId,
        input.target.conversationId,
      );
      expect(detail?.latestGeneration?.status).toBe("completed");
      expect(detail?.messages).toHaveLength(2);
      expect(detail?.messages.at(-1)?.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("当前知识库没有可检索的资料"),
          }),
        ]),
      );
    },
  );

  it("引用已经发出但模型尚未输出时取消，不保存只有引用的助手消息", async () => {
    const { base } = await readyBase();
    const input = command(base.id);
    await createGenerationCommandRecord(input, database.db);
    const started = Promise.withResolvers<void>();
    const run = execution();
    run.deps.chatModel = {
      async *stream(request) {
        started.resolve();
        await new Promise<void>((resolve) =>
          request.abortSignal!.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        request.abortSignal!.throwIfAborted();
        yield { type: "finish", reason: "stop" };
      },
    };
    const task = executeGeneration(input.generationId, run.deps);
    await started.promise;
    expect(run.events.some((event) => event.type === "knowledge.sources")).toBe(
      true,
    );
    await requestGenerationCancellationForOwner(
      { ownerId, generationId: input.generationId, now: new Date() },
      database.db,
    );
    run.cancel();
    expect(await task).toEqual({ kind: "cancelled", assistantMessageId: null });
    expect(
      (await getConversationForOwner(ownerId, input.target.conversationId))
        ?.messages,
    ).toHaveLength(1);
  });
  it("原知识库已删除时拒绝重新生成，保留旧回答", async () => {
    const { base } = await readyBase();
    const input = command(base.id);
    await createGenerationCommandRecord(input, database.db);
    const result = await executeGeneration(
      input.generationId,
      execution().deps,
    );
    if (result.kind !== "completed") throw new Error("未完成");
    await database.client`DELETE FROM knowledge_bases WHERE id = ${base.id} AND owner_id = ${ownerId}`;
    const regenerated = await createRegenerationCommandRecord(
      {
        ownerId,
        generationId: randomUUID(),
        conversationId: input.target.conversationId,
        assistantMessageId: result.assistantMessageId,
        now: new Date(),
      },
      database.db,
    );
    expect(regenerated.kind).toBe("regeneration_not_allowed");
    expect(
      (
        await getConversationForOwner(ownerId, input.target.conversationId)
      )?.messages.at(-1)?.id,
    ).toBe(result.assistantMessageId);
  });
  it("真实混合检索结果先注入上下文，再生成；刷新、分享、删除文件后引用快照仍然存在", async () => {
    const { base, document } = await readyBase();
    const input = command(base.id);
    expect((await createGenerationCommandRecord(input, database.db)).kind).toBe(
      "created",
    );
    const run = execution();
    const result = await executeGeneration(input.generationId, run.deps);
    expect(result.kind).toBe("completed");
    expect(run.requests).toHaveLength(1);
    expect(run.requests[0]?.instructions).toContain("不是指令");
    expect(run.requests[0]?.messages.at(-2)).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: expect.stringContaining("BM25") }],
    });
    expect(run.requests[0]?.messages.at(-1)).toMatchObject({
      role: "user",
      parts: input.parts,
    });
    const sourceEvent = run.events.find((e) => e.type === "knowledge.sources");
    expect(sourceEvent).toMatchObject({
      sources: [{ originalName: "数据库.md", number: 1 }],
    });
    expect(run.events.indexOf(sourceEvent!)).toBeLessThan(
      run.events.findIndex((e) => e.type === "text.delta"),
    );
    const detail = await getConversationForOwner(
      ownerId,
      input.target.conversationId,
    );
    expect(detail?.latestGeneration?.knowledgeBaseId).toBe(base.id);
    expect(detail?.messages.at(-1)?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "knowledge-sources" }),
      ]),
    );
    const token = randomUUID().replaceAll("-", "").repeat(2);
    const share = await createConversationShareRecordForOwner(
      {
        ownerId,
        conversationId: input.target.conversationId,
        id: randomUUID(),
        token,
        now: new Date(),
      },
      database.db,
    );
    expect(share.kind).toBe("created");
    await deleteKnowledgeDocument(ownerId, base.id, document.id, dependencies);
    expect(await repository.listDocuments(ownerId, base.id)).toHaveLength(0);
    const snapshot = (
      await getConversationShareRecordByToken(token, database.db)
    )?.snapshot;
    expect(JSON.stringify(snapshot)).toContain("BM25");
    expect(JSON.stringify(snapshot)).not.toContain("objectKey");
    expect(JSON.stringify(snapshot)).not.toContain("rerankScore");
    expect(
      (
        await getConversationForOwner(ownerId, input.target.conversationId)
      )?.messages.at(-1)?.parts,
    ).toEqual(detail?.messages.at(-1)?.parts);
    const empty = command(base.id);
    await createGenerationCommandRecord(empty, database.db);
    const emptyRun = execution();
    await executeGeneration(empty.generationId, emptyRun.deps);
    expect(emptyRun.requests).toHaveLength(0);
    expect(JSON.stringify(emptyRun.events)).toContain("没有可检索的资料");
  });

  it("同一会话下一轮关闭知识库，不检索；重新生成沿用原轮选库", async () => {
    const { base } = await readyBase();
    const first = command(base.id);
    await createGenerationCommandRecord(first, database.db);
    const firstResult = await executeGeneration(
      first.generationId,
      execution().deps,
    );
    if (firstResult.kind !== "completed") throw new Error("未完成");
    const regenerationId = randomUUID();
    expect(
      (
        await createRegenerationCommandRecord(
          {
            ownerId,
            generationId: regenerationId,
            conversationId: first.target.conversationId,
            assistantMessageId: firstResult.assistantMessageId,
            now: new Date(),
          },
          database.db,
        )
      ).kind,
    ).toBe("created");
    const regeneration = execution(vi.fn(retrieve));
    await executeGeneration(regenerationId, regeneration.deps);
    expect(regeneration.deps.knowledgeRetriever).toHaveBeenCalledWith(
      expect.objectContaining({ baseId: base.id, ownerId }),
    );
    const next = command(null, first.target.conversationId, true);
    await createGenerationCommandRecord(next, database.db);
    const off = execution(vi.fn(retrieve));
    await executeGeneration(next.generationId, off.deps);
    expect(off.deps.knowledgeRetriever).not.toHaveBeenCalled();
    expect(off.requests[0]?.instructions).toBeUndefined();
    expect(off.events.some((e) => e.type === "knowledge.sources")).toBe(false);
    expect(
      (await getConversationForOwner(ownerId, next.target.conversationId))
        ?.latestGeneration?.knowledgeBaseId,
    ).toBeNull();
  });

  it("归属校验阻止越权上传和选库，失败不留下空会话；选库参与幂等判断", async () => {
    const foreign = await repository.createBase(strangerId, "别人的知识库");
    expect(
      (await repository.listBases(ownerId)).some((b) => b.id === foreign.id),
    ).toBe(false);
    await expect(repository.listDocuments(ownerId, foreign.id)).rejects.toThrow(
      "KNOWLEDGE_NOT_FOUND",
    );
    await expect(
      uploadKnowledgeDocument(
        ownerId,
        foreign.id,
        new File(["x"], "x.txt"),
        dependencies,
      ),
    ).rejects.toThrow("KNOWLEDGE_NOT_FOUND");
    const bad = command(foreign.id);
    expect((await createGenerationCommandRecord(bad, database.db)).kind).toBe(
      "knowledge_not_found",
    );
    expect(
      await getConversationForOwner(ownerId, bad.target.conversationId),
    ).toBeNull();
    const { base } = await readyBase();
    const input = command(base.id);
    expect((await createGenerationCommandRecord(input, database.db)).kind).toBe(
      "created",
    );
    expect(
      (
        await createGenerationCommandRecord(
          { ...input, generationId: randomUUID() },
          database.db,
        )
      ).kind,
    ).toBe("idempotent");
    expect(
      (
        await createGenerationCommandRecord(
          { ...input, generationId: randomUUID(), knowledgeBaseId: null },
          database.db,
        )
      ).kind,
    ).toBe("message_id_conflict");
  });

  it("入库排队失败保留可删除的失败记录", async () => {
    const base = await repository.createBase(ownerId, "失败测试");
    await expect(
      uploadKnowledgeDocument(ownerId, base.id, new File(["test"], "x.txt"), {
        ...dependencies,
        enqueue: async () => {
          throw new Error("redis unavailable");
        },
      }),
    ).rejects.toThrow("KNOWLEDGE_UPLOAD_FAILED");
    const docs = await repository.listDocuments(ownerId, base.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.status).toBe("failed");
    await deleteKnowledgeDocument(ownerId, base.id, docs[0]!.id, dependencies);
    expect(objects.has(docs[0]!.objectKey)).toBe(false);
  });

  it("检索失败明确失败，不偷偷降级为普通聊天", async () => {
    const base = await repository.createBase(ownerId, "故障测试");
    const input = command(base.id);
    await createGenerationCommandRecord(input, database.db);
    const run = execution(async () => {
      throw new Error("retrieval unavailable");
    });
    await expect(
      executeGeneration(input.generationId, run.deps),
    ).rejects.toThrow("retrieval unavailable");
    expect(run.requests).toHaveLength(0);
    expect(run.events.at(-1)?.type).toBe("generation.failed");
    expect(
      (await getConversationForOwner(ownerId, input.target.conversationId))
        ?.latestGeneration?.status,
    ).toBe("failed");
  });

  it("检索期间停止会中止信号，且不保存只有引用的空回答", async () => {
    const base = await repository.createBase(ownerId, "取消测试");
    const input = command(base.id);
    await createGenerationCommandRecord(input, database.db);
    const started = Promise.withResolvers<void>();
    const run = execution(async ({ signal }) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      signal.throwIfAborted();
      return [];
    });
    const task = executeGeneration(input.generationId, run.deps);
    await started.promise;
    await requestGenerationCancellationForOwner(
      { ownerId, generationId: input.generationId, now: new Date() },
      database.db,
    );
    run.cancel();
    expect(await task).toEqual({ kind: "cancelled", assistantMessageId: null });
    expect(run.requests).toHaveLength(0);
    expect(
      (await getConversationForOwner(ownerId, input.target.conversationId))
        ?.messages,
    ).toHaveLength(1);
  });
});
