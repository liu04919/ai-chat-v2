import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDatabase } from "./client";
import { createGenerationCommandRecord, type CreateGenerationCommandRecordInput } from "./generation-command";
import { claimGenerationExecution, completeGenerationExecution } from "./generation-execution";
import { requestGenerationCancellationForOwner, cancelGenerationExecution } from "./generation-cancellation";
import { completeImageGenerationExecution } from "./image-generation-execution";
import { deleteConversationRecordForOwner } from "./conversation-mutations";
import { migrateDatabase } from "./migration";
import { conversations, user } from "./schema/index";
import { loadIntegrationTestEnvironment } from "./test-environment";

const url = loadIntegrationTestEnvironment();
const database = createDatabase(url, 6);
const db = database.db;
const ownerId = randomUUID();
beforeAll(async () => {
  await migrateDatabase({ databaseUrl: url, migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
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

  it.each(["complete", "image", "cancel", "request-cancel", "claim"] as const)(
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
