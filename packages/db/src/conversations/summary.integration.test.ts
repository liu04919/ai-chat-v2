import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../client";
import {
  saveConversationSummary,
  type SaveConversationSummaryInput,
} from "./summary";
import {
  claimGenerationExecution,
  completeGenerationExecution,
} from "../generations/execution";
import { requestGenerationCancellationForOwner } from "../generations/cancellation";
import { createRegenerationCommandRecord } from "../generations/regeneration";
import { deleteConversationRecordForOwner } from "./mutations";
import { migrateDatabase } from "../migration";
import {
  conversationSummaries,
  conversations,
  generations,
  messages,
  user,
} from "../schema/index";
import { loadIntegrationTestEnvironment } from "../test-environment";

const url = loadIntegrationTestEnvironment();
const database = createDatabase(url, 4);
const db = database.db;
const ownerId = randomUUID();
beforeAll(async () => {
  await migrateDatabase({
    databaseUrl: url,
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  });
  await db
    .insert(user)
    .values({
      id: ownerId,
      name: "Summary Test",
      email: `${ownerId}@example.com`,
    });
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, ownerId));
  await database.close();
});

async function fixture() {
  const conversationId = randomUUID();
  const generationId = randomUUID();
  const ids = Array.from({ length: 9 }, () => randomUUID());
  await db
    .insert(conversations)
    .values({ id: conversationId, ownerId, title: "summary", mode: "chat" });
  await db
    .insert(messages)
    .values(
      ids.map((id, sequence) => ({
        id,
        sequence,
        conversationId,
        role: sequence % 2 === 0 ? ("user" as const) : ("assistant" as const),
        parts:
          sequence % 2 === 0
            ? [{ type: "text" as const, text: `question-${sequence}` }]
            : [
                {
                  id: randomUUID(),
                  type: "text" as const,
                  text: `answer-${sequence}`,
                },
              ],
      })),
    );
  await db
    .insert(generations)
    .values({
      id: generationId,
      conversationId,
      userMessageId: ids[8]!,
      status: "queued",
      reasoningEffort: "medium",
    });
  const claim = await claimGenerationExecution(generationId, new Date(), db);
  expect(claim.kind).toBe("claimed");
  const input: SaveConversationSummaryInput = {
    conversationId,
    generationId,
    expectedVersion: 0,
    coveredThroughMessageId: ids[3]!,
    coveredThroughSequence: 3,
    content: "前两轮的已确认决定",
    tokenCount: 12,
    modelId: "fake-sol",
    tokenizer: "test",
    promptVersion: 1,
  };
  return { input, ids, claim };
}

describe("历史摘要的持久化边界", () => {
  it("原子保存内容和边界，不删除原文；下次领取仅加载摘要后面的历史", async () => {
    const { input, ids } = await fixture();
    const saved = await saveConversationSummary(input, db);
    expect(saved).toMatchObject({
      version: 1,
      content: input.content,
      coveredThroughSequence: 3,
    });
    expect(
      await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, input.conversationId)),
    ).toHaveLength(9);
    await db
      .update(generations)
      .set({ status: "failed" })
      .where(eq(generations.id, input.generationId));
    const nextId = randomUUID();
    await db
      .insert(generations)
      .values({
        id: nextId,
        conversationId: input.conversationId,
        userMessageId: ids[8]!,
        status: "queued",
        reasoningEffort: "medium",
      });
    const next = await claimGenerationExecution(nextId, new Date(), db);
    expect(next.kind).toBe("claimed");
    if (next.kind !== "claimed") throw new Error("claim failed");
    expect(next.execution.summary?.version).toBe(1);
    expect(next.execution.messages.map((message) => message.sequence)).toEqual([
      4, 5, 6, 7, 8,
    ]);
  });

  it("并发保存同一摘要版本只有一个成功，不能覆盖较新边界", async () => {
    const { input } = await fixture();
    const results = await Promise.allSettled([
      saveConversationSummary(input, db),
      saveConversationSummary(input, db),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      (
        await db
          .select()
          .from(conversationSummaries)
          .where(eq(conversationSummaries.conversationId, input.conversationId))
      )[0]?.version,
    ).toBe(1);
  });

  it("滚动摘要整体替换并推进版本，拒绝边界回退", async () => {
    const { input, ids } = await fixture();
    await saveConversationSummary(input, db);
    const replacement = {
      ...input,
      expectedVersion: 1,
      coveredThroughSequence: 5,
      coveredThroughMessageId: ids[5]!,
      content: "替换后的摘要",
    };
    expect(await saveConversationSummary(replacement, db)).toMatchObject({
      version: 2,
      content: "替换后的摘要",
      coveredThroughSequence: 5,
    });
    await expect(
      saveConversationSummary({ ...input, expectedVersion: 2 }, db),
    ).rejects.toThrow("摘要边界已变化");
  });

  it.each(["cancel", "failed"] as const)(
    "%s 后不能保存摘要，也不能残留部分记录",
    async (state) => {
      const { input } = await fixture();
      if (state === "cancel")
        await requestGenerationCancellationForOwner(
          { ownerId, generationId: input.generationId, now: new Date() },
          db,
        );
      else
        await db
          .update(generations)
          .set({ status: "failed" })
          .where(eq(generations.id, input.generationId));
      await expect(saveConversationSummary(input, db)).rejects.toThrow(
        "生成已停止",
      );
      expect(
        await db
          .select()
          .from(conversationSummaries)
          .where(
            eq(conversationSummaries.conversationId, input.conversationId),
          ),
      ).toHaveLength(0);
    },
  );

  it("拒绝跨会话、错误序号、切开轮次和覆盖最近一轮", async () => {
    const { input, ids } = await fixture();
    const other = await fixture();
    for (const invalid of [
      { ...input, coveredThroughMessageId: other.ids[3]! },
      { ...input, coveredThroughSequence: 5 },
      { ...input, coveredThroughSequence: 2, coveredThroughMessageId: ids[2]! },
      { ...input, coveredThroughSequence: 7, coveredThroughMessageId: ids[7]! },
    ])
      await expect(saveConversationSummary(invalid, db)).rejects.toThrow(
        "完整历史轮次",
      );
  });

  it("重新生成最后一个回答不影响摘要，旧回答不会从摘要回流", async () => {
    const { input } = await fixture();
    await saveConversationSummary(input, db);
    const assistantMessageId = randomUUID();
    await completeGenerationExecution(
      {
        generationId: input.generationId,
        assistantMessageId,
        assistantParts: [
          { id: "answer", type: "text", text: "将被重新生成的回答" },
        ],
        now: new Date(),
      },
      db,
    );
    const generationId = randomUUID();
    expect(
      (
        await createRegenerationCommandRecord(
          {
            ownerId,
            conversationId: input.conversationId,
            assistantMessageId,
            generationId,
            now: new Date(),
          },
          db,
        )
      ).kind,
    ).toBe("created");
    const claim = await claimGenerationExecution(generationId, new Date(), db);
    if (claim.kind !== "claimed") throw new Error("claim failed");
    expect(claim.execution.summary?.content).toBe(input.content);
    expect(
      claim.execution.messages.some(
        (message) => message.id === assistantMessageId,
      ),
    ).toBe(false);
    expect(claim.execution.messages.at(-1)?.id).toBe(
      claim.execution.userMessageId,
    );
  });

  it("删除与保存并发时仍按父会话先加锁，不死锁、不复活摘要", async () => {
    const { input } = await fixture();
    await saveConversationSummary(input, db);
    let pending: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
      await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .for("update");
      const [connection] = await tx.execute<{ pid: number }>(
        sql`SELECT pg_backend_pid() AS pid`,
      );
      pending = saveConversationSummary({ ...input, expectedVersion: 1 }, db);
      void pending.catch(() => {});
      await vi.waitFor(
        async () => {
          expect(
            (
              await database.client`SELECT pid FROM pg_stat_activity WHERE ${connection!.pid} = ANY(pg_blocking_pids(pid))`
            ).length,
          ).toBeGreaterThan(0);
        },
        { timeout: 3000, interval: 10 },
      );
      await tx
        .delete(conversations)
        .where(eq(conversations.id, input.conversationId));
    });
    await expect(pending).rejects.toThrow("会话已删除");
    expect(
      await db
        .select()
        .from(conversationSummaries)
        .where(eq(conversationSummaries.conversationId, input.conversationId)),
    ).toHaveLength(0);
  });

  it("删除会话级联清理派生摘要；不关联其他会话", async () => {
    const { input } = await fixture();
    const other = await fixture();
    await saveConversationSummary(input, db);
    await saveConversationSummary(other.input, db);
    await deleteConversationRecordForOwner(ownerId, input.conversationId, db);
    expect(
      await db
        .select()
        .from(conversationSummaries)
        .where(eq(conversationSummaries.conversationId, input.conversationId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(conversationSummaries)
        .where(
          eq(conversationSummaries.conversationId, other.input.conversationId),
        ),
    ).toHaveLength(1);
  });
});
