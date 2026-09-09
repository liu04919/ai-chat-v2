import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { countStoredMessage } from "@ai-chat/model-context";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "./client";
import {
  saveAttachmentTokenCount,
  saveMessageTokenCounts,
} from "./context-token-counts";
import { createGenerationCommandRecord } from "./generation-command";
import {
  cancelGenerationExecution,
  requestGenerationCancellationForOwner,
} from "./generation-cancellation";
import {
  claimGenerationExecution,
  completeGenerationExecution,
} from "./generation-execution";
import { migrateDatabase } from "./migration";
import { attachments, messages, user } from "./schema/index";
import { loadIntegrationTestEnvironment } from "./test-environment";

const url = loadIntegrationTestEnvironment();
const database = createDatabase(url, 2);
const db = database.db;
const ownerId = randomUUID();
beforeAll(async () => {
  await migrateDatabase({
    databaseUrl: url,
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  await db
    .insert(user)
    .values({
      id: ownerId,
      name: "Token Cache",
      email: `${ownerId}@example.com`,
    });
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, ownerId));
  await database.close();
});

async function fixture() {
  const conversationId = randomUUID(),
    generationId = randomUUID(),
    userMessageId = randomUUID();
  const parts = [{ type: "text" as const, text: "请继续实现历史摘要" }];
  expect(
    (
      await createGenerationCommandRecord(
        {
          ownerId,
          generationId,
          userMessageId,
          conversationTitle: "计数",
          target: { type: "new", mode: "chat", conversationId },
          parts,
          reasoningEffort: "medium",
          tools: { webSearch: false, mcpToolIds: [] },
          now: new Date(),
        },
        db,
      )
    ).kind,
  ).toBe("created");
  const claim = await claimGenerationExecution(generationId, new Date(), db);
  if (claim.kind !== "claimed") throw new Error("claim failed");
  return {
    conversationId,
    generationId,
    userMessageId,
    parts,
    execution: claim.execution,
  };
}

describe("派生 token 缓存落库", () => {
  it("用户消息写入即有计数，领取时读取；回答与停止输出同样持久化", async () => {
    for (const outcome of ["complete", "cancel"] as const) {
      const input = await fixture();
      expect(input.execution.messages[0]!.contextTokenCount).toEqual(
        countStoredMessage({ role: "user", parts: input.parts }),
      );
      const assistantMessageId = randomUUID();
      const assistantParts = [
        { id: "a", type: "text" as const, text: "已开始处理" },
        {
          id: "t",
          type: "tool-call" as const,
          toolCallId: "call",
          toolName: "mail.send",
          input: { to: "example@example.com" },
        },
      ];
      if (outcome === "cancel") {
        await requestGenerationCancellationForOwner(
          { ownerId, generationId: input.generationId, now: new Date() },
          db,
        );
        expect(
          await cancelGenerationExecution(
            {
              generationId: input.generationId,
              assistantMessageId,
              assistantParts,
              now: new Date(),
            },
            db,
          ),
        ).toBe(true);
      } else
        await completeGenerationExecution(
          {
            generationId: input.generationId,
            assistantMessageId,
            assistantParts,
            now: new Date(),
          },
          db,
        );
      const [saved] = await db
        .select()
        .from(messages)
        .where(eq(messages.id, assistantMessageId));
      expect(saved?.parts).toEqual(assistantParts);
      expect(saved?.contextTokenCount).toEqual(
        countStoredMessage({ role: "assistant", parts: assistantParts }),
      );
    }
  });

  it("缓存刷新不能跨账户或跨会话写消息，也不修改原正文", async () => {
    const first = await fixture(),
      second = await fixture();
    const count = { version: "new-rule", textTokens: 42 };
    await saveMessageTokenCounts(
      {
        ownerId: "other-owner",
        conversationId: first.conversationId,
        counts: [{ id: first.userMessageId, count }],
      },
      db,
    );
    expect(
      (
        await db
          .select()
          .from(messages)
          .where(eq(messages.id, first.userMessageId))
      )[0]!.contextTokenCount?.version,
    ).not.toBe(count.version);
    await saveMessageTokenCounts(
      {
        ownerId,
        conversationId: first.conversationId,
        counts: [
          { id: first.userMessageId, count },
          { id: second.userMessageId, count },
        ],
      },
      db,
    );
    expect(
      (
        await db
          .select()
          .from(messages)
          .where(eq(messages.id, first.userMessageId))
      )[0],
    ).toMatchObject({ parts: first.parts, contextTokenCount: count });
    expect(
      (
        await db
          .select()
          .from(messages)
          .where(eq(messages.id, second.userMessageId))
      )[0]!.contextTokenCount?.version,
    ).not.toBe(count.version);
  });

  it("附件缓存仅可更新本人已就绪对象，包含版本与 ETag", async () => {
    const id = randomUUID();
    await db
      .insert(attachments)
      .values({
        id,
        ownerId,
        objectKey: `test/${id}`,
        originalName: "test.png",
        mediaType: "image/png",
        sizeBytes: 100,
        status: "ready",
      });
    const count = {
      version: "test",
      etag: '"v1"',
      kind: "image" as const,
      width: 512,
      height: 512,
      tokens: 308,
    };
    await saveAttachmentTokenCount(
      { ownerId: "other-owner", attachmentId: id, count },
      db,
    );
    expect(
      (await db.select().from(attachments).where(eq(attachments.id, id)))[0]!
        .contextTokenCount,
    ).toBeNull();
    await saveAttachmentTokenCount({ ownerId, attachmentId: id, count }, db);
    expect(
      (await db.select().from(attachments).where(eq(attachments.id, id)))[0]!
        .contextTokenCount,
    ).toEqual(count);
  });
});
