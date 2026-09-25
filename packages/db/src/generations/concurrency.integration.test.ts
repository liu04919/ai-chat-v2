import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDatabase } from "../client";
import { createGenerationCommandRecord, type CreateGenerationCommandRecordInput } from "./command";
import { claimGenerationExecution, completeGenerationExecution, failGenerationExecution } from "./execution";
import { requestGenerationCancellationForOwner, cancelGenerationExecution } from "./cancellation";
import { completeImageGenerationExecution } from "./image-execution";
import { deleteConversationRecordForOwner } from "../conversations/mutations";
import { getConversationRecordForOwner } from "../conversations/reader";
import { migrateDatabase } from "../migration";
import { attachments, conversations, user } from "../schema/index";
import { loadIntegrationTestEnvironment } from "../test-environment";

const url = loadIntegrationTestEnvironment();
const database = createDatabase(url, 6);
const db = database.db;
const ownerId = randomUUID();
beforeAll(async () => {
  await migrateDatabase({ databaseUrl: url, migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  await db.insert(user).values({ id: ownerId, name: "Concurrency", email: `${ownerId}@example.com` });
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, ownerId));
  await database.close();
});
function command(): CreateGenerationCommandRecordInput {
  return { ownerId, generationId: randomUUID(), conversationTitle: "并发测试", now: new Date(),
    target: { type: "new", conversationId: randomUUID(), mode: "chat" },
    userMessageId: randomUUID(), parts: [{ type: "text", text: "test" }],
    reasoningEffort: "medium", tools: { webSearch: false, mcpToolIds: [] } };
}

// 两个请求均完成事务前的幂等查询后，再开始实际数据库事务。
function concurrentDatabase() {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let arrived = 0;
  return new Proxy(db, { get(target, key) {
    if (key === "transaction") return async (...args: Parameters<typeof db.transaction>) => {
      if (++arrived === 2) release();
      await barrier;
      return target.transaction(...args);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

describe("Generation 数据库并发", () => {
  it.each(["new", "existing"] as const)("%s 会话的同一次请求并发提交只创建一次", async (type) => {
    const input = command();
    if (type === "existing") {
      await db.insert(conversations).values({ id: input.target.conversationId, ownerId, title: "existing", mode: "chat" });
      input.target = { type, conversationId: input.target.conversationId };
    }
    const concurrent = concurrentDatabase();
    const results = await Promise.all([
      createGenerationCommandRecord(input, concurrent),
      createGenerationCommandRecord({ ...input, generationId: randomUUID() }, concurrent),
    ]);
    expect(results.map(result => result.kind).sort()).toEqual(["created", "idempotent"]);
    expect(results.map(result => "generation" in result ? result.generation.id : null)[0])
      .toBe(results.map(result => "generation" in result ? result.generation.id : null)[1]);
    expect(await database.client`SELECT id FROM messages WHERE conversation_id = ${input.target.conversationId}`).toHaveLength(1);
    expect(await database.client`SELECT id FROM generations WHERE conversation_id = ${input.target.conversationId}`).toHaveLength(1);
  });

  it("相同标识但不同内容不能当作幂等成功", async () => {
    const input = command();
    const concurrent = concurrentDatabase();
    const results = await Promise.all([
      createGenerationCommandRecord(input, concurrent),
      createGenerationCommandRecord({ ...input, generationId: randomUUID(), parts: [{ type: "text", text: "different" }] }, concurrent),
    ]);
    expect(results.map(result => result.kind).sort()).toEqual(["created", "message_id_conflict"]);
  });

  it("不同新会话争用同一消息标识，冲突请求回滚且不残留空会话", async () => {
    const input = command();
    const other = { ...command(), userMessageId: input.userMessageId };
    const concurrent = concurrentDatabase();
    const results = await Promise.all([
      createGenerationCommandRecord(input, concurrent),
      createGenerationCommandRecord(other, concurrent),
    ]);
    expect(results.map(result => result.kind).sort()).toEqual(["created", "message_id_conflict"]);
    expect(await database.client`SELECT id FROM conversations WHERE id IN (${input.target.conversationId}, ${other.target.conversationId})`).toHaveLength(1);
  });

  it("同一会话的不同消息并发提交，只允许一个活跃任务", async () => {
    const conversationId = randomUUID();
    await db.insert(conversations).values({
      id: conversationId, ownerId, mode: "chat", title: "并发发送",
    });
    const concurrent = concurrentDatabase();
    const inputs = [command(), command()].map(input => ({
      ...input, target: { type: "existing" as const, conversationId },
    }));
    const results = await Promise.all(inputs.map(input =>
      createGenerationCommandRecord(input, concurrent),
    ));
    expect(results.map(result => result.kind).sort()).toEqual(["active_generation", "created"]);
    const created = results.find(result => result.kind === "created")!;
    expect(results.find(result => result.kind === "active_generation")).toEqual({
      kind: "active_generation", activeGenerationId: created.generation.id,
    });
    expect(await database.client`SELECT sequence FROM messages WHERE conversation_id = ${conversationId}`)
      .toEqual([{ sequence: 0 }]);
    expect(await database.client`SELECT id FROM generations WHERE conversation_id = ${conversationId}`)
      .toHaveLength(1);
  });

  it("两个新会话并发争用附件，失败一方回滚而不留下空会话", async () => {
    const attachmentId = randomUUID();
    await db.insert(attachments).values({
      id: attachmentId, ownerId, objectKey: `attachments/${attachmentId}`,
      originalName: "shared.png", mediaType: "image/png", sizeBytes: 100,
      status: "ready", readyAt: new Date(),
    });
    const inputs = [command(), command()].map(input => ({
      ...input, parts: [...input.parts, { type: "attachment" as const, attachmentId }],
    }));
    const concurrent = concurrentDatabase();
    const results = await Promise.all(inputs.map(input =>
      createGenerationCommandRecord(input, concurrent),
    ));
    expect(results.map(result => result.kind).sort()).toEqual(["attachment_in_use", "created"]);
    expect(results.find(result => result.kind === "attachment_in_use"))
      .toEqual({ kind: "attachment_in_use", attachmentId });
    for (let index = 0; index < inputs.length; index++) {
      const expectedCount = results[index]!.kind === "created" ? 1 : 0;
      const conversationId = inputs[index]!.target.conversationId;
      expect(await database.client`SELECT id FROM conversations WHERE id = ${conversationId}`)
        .toHaveLength(expectedCount);
      expect(await database.client`SELECT id FROM messages WHERE conversation_id = ${conversationId}`)
        .toHaveLength(expectedCount);
      expect(await database.client`SELECT id FROM generations WHERE conversation_id = ${conversationId}`)
        .toHaveLength(expectedCount);
    }
    const [attachment] = await database.client`SELECT linked_at FROM attachments WHERE id = ${attachmentId}`;
    expect(attachment!.linked_at).not.toBeNull();
  });

  it.each(["complete", "fail", "image", "cancel", "request-cancel", "claim"] as const)(
    "删除已持有会话锁时，%s 等待后安全退出，不与级联删除死锁", async (operation) => {
      const input = command();
      if (operation === "image") {
        input.target = { ...input.target, type: "new", mode: "image" };
        input.reasoningEffort = null;
      }
      await createGenerationCommandRecord(input, db);
      if (operation !== "claim") await claimGenerationExecution(input.generationId, new Date(), db);
      if (operation === "cancel") await requestGenerationCancellationForOwner({ ownerId, generationId: input.generationId, now: new Date() }, db);
      const args = { generationId: input.generationId, assistantMessageId: randomUUID(), now: new Date(),
        assistantParts: [{ id: randomUUID(), type: "text" as const, text: "answer" }] };
      let pending: Promise<unknown> | undefined;
      try {
        await db.transaction(async tx => {
          await tx.select().from(conversations).where(eq(conversations.id, input.target.conversationId)).for("update");
          const [connection] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
          const execute = () => {
            switch (operation) {
              case "complete": return completeGenerationExecution(args, db);
              case "fail": return failGenerationExecution({
                generationId: input.generationId, errorCode: "CHAT_GENERATION_FAILED",
                partialMessage: { id: args.assistantMessageId, parts: args.assistantParts },
                now: args.now,
              }, db);
              case "cancel": return cancelGenerationExecution(args, db);
              case "request-cancel": return requestGenerationCancellationForOwner({ ...args, ownerId }, db);
              case "claim": return claimGenerationExecution(input.generationId, new Date(), db);
              case "image": return completeImageGenerationExecution({ ...args, attachment: {
                id: randomUUID(), objectKey: randomUUID(), originalName: "test.png", mediaType: "image/png", sizeBytes: 100,
              } }, db);
            }
          };
          pending = execute();
          // 立即挂载错误处理，等待 SQL 锁时也不会产生未处理的 rejection。
          void pending.catch(() => {});
          await vi.waitFor(async () => {
            const blocked = await database.client`SELECT pid FROM pg_stat_activity WHERE ${connection!.pid} = ANY(pg_blocking_pids(pid))`;
            expect(blocked.length).toBeGreaterThan(0);
          }, { timeout: 3000, interval: 10 });
          // 复用持有父行锁的事务执行真实删除函数，精确构造之前的死锁交错。
          const deletingDb = new Proxy(db, { get(target, key) {
            if (key === "transaction") return (callback: (value: typeof tx) => Promise<unknown>) => callback(tx);
            return Reflect.get(target, key, target);
          } });
          expect(await deleteConversationRecordForOwner(ownerId, input.target.conversationId, deletingDb)).not.toBeNull();
        });
        const result = await pending;
        expect(result).toEqual(operation === "claim" ? { kind: "not_queued" }
          : operation === "request-cancel" ? { kind: "not_found" } : operation === "complete" ? null : false);
        expect(await database.client`SELECT id FROM messages WHERE conversation_id = ${input.target.conversationId}`).toHaveLength(0);
      } finally {
        await pending?.catch(() => {});
      }
    }, 10000,
  );
});

describe("失败 partial 与终态原子保存", () => {
  it.each([
    [{ id: "r", type: "reasoning" as const, text: "思" }],
    [{ id: "call", type: "tool-call" as const, toolCallId: "c",
      toolName: "web_search", input: { query: "问题" } }],
  ])("无正文的 partial 也保存，重复失败不重复插入 %#", async (parts) => {
    const input = command();
    await createGenerationCommandRecord(input, db);
    await claimGenerationExecution(input.generationId, new Date(), db);
    const partialMessage = { id: randomUUID(), parts: [parts] };
    const failure = {
      generationId: input.generationId, errorCode: "CHAT_GENERATION_FAILED",
      partialMessage, now: new Date(),
    };
    expect(await failGenerationExecution(failure, db)).toBe(true);
    expect(await failGenerationExecution({
      ...failure, partialMessage: { ...partialMessage, id: randomUUID() },
    }, db)).toBe(false);
    const detail = await getConversationRecordForOwner(
      ownerId, input.target.conversationId, { database: db },
    );
    expect(detail).toMatchObject({
      activeGeneration: null,
      latestGeneration: { id: input.generationId, status: "failed" },
      messages: [
        { role: "user", sequence: 0 },
        { id: partialMessage.id, role: "assistant", sequence: 1, parts: partialMessage.parts },
      ],
    });
    expect(await db.query.generations.findFirst({
      where: (table, { eq }) => eq(table.id, input.generationId),
    })).toMatchObject({ assistantMessageId: partialMessage.id, status: "failed" });
    expect(await db.query.messages.findFirst({
      where: (table, { eq }) => eq(table.id, partialMessage.id),
    })).toMatchObject({
      contextTokenCount: { version: expect.any(String), textTokens: expect.any(Number) },
    });
  });

  it("partial 插入失败时整笔事务回滚，不提交 failed 状态", async () => {
    const input = command();
    await createGenerationCommandRecord(input, db);
    await claimGenerationExecution(input.generationId, new Date(), db);
    await expect(failGenerationExecution({
      generationId: input.generationId, errorCode: "CHAT_GENERATION_FAILED",
      partialMessage: {
        id: input.userMessageId,
        parts: [{ id: "text", type: "text", text: "部分" }],
      },
      now: new Date(),
    }, db)).rejects.toThrow();
    expect(await db.query.generations.findFirst({
      where: (table, { eq }) => eq(table.id, input.generationId),
    })).toMatchObject({ status: "running", assistantMessageId: null, errorCode: null });
    expect(await db.query.messages.findMany({
      where: (table, { eq }) => eq(table.conversationId, input.target.conversationId),
    })).toMatchObject([{ id: input.userMessageId, role: "user" }]);
  });

  it("已有取消请求时失败落库不抢占终态，也不插入 partial", async () => {
    const input = command();
    await createGenerationCommandRecord(input, db);
    await claimGenerationExecution(input.generationId, new Date(), db);
    await requestGenerationCancellationForOwner({
      ownerId, generationId: input.generationId, now: new Date(),
    }, db);
    expect(await failGenerationExecution({
      generationId: input.generationId, errorCode: "CHAT_GENERATION_FAILED",
      partialMessage: { id: randomUUID(), parts: [{ id: "r", type: "reasoning", text: "思" }] },
      now: new Date(),
    }, db)).toBe(false);
    expect(await db.query.generations.findFirst({
      where: (table, { eq }) => eq(table.id, input.generationId),
    })).toMatchObject({ status: "running", assistantMessageId: null, errorCode: null });
    expect(await db.query.messages.findMany({
      where: (table, { eq }) => eq(table.conversationId, input.target.conversationId),
    })).toHaveLength(1);
  });
});
