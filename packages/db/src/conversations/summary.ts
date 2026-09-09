import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { getDatabase } from "../client";
import { lockGenerationConversation } from "../generations/conversation-lock";
import { conversationSummaries, generations, messages } from "../schema/index";

export type ConversationSummaryRecord =
  typeof conversationSummaries.$inferSelect;
export type SaveConversationSummaryInput = Omit<
  ConversationSummaryRecord,
  "version" | "updatedAt" | "generationId"
> & {
  generationId: string;
  expectedVersion: number;
};

/** 模型调用在事务外；这里只有校验与原子替换，锁顺序与取消、删除一致。 */
export async function saveConversationSummary(
  input: SaveConversationSummaryInput,
  database = getDatabase(),
): Promise<ConversationSummaryRecord> {
  return database.transaction(async (transaction) => {
    if (!(await lockGenerationConversation(transaction, input.generationId))) {
      throw new Error("SUMMARY_SAVE_CONFLICT: 会话已删除");
    }
    const [generation] = await transaction
      .select()
      .from(generations)
      .where(
        and(
          eq(generations.id, input.generationId),
          eq(generations.conversationId, input.conversationId),
          eq(generations.status, "running"),
          isNull(generations.cancelRequestedAt),
        ),
      )
      .for("update");
    if (!generation) throw new Error("SUMMARY_SAVE_CONFLICT: 生成已停止");
    const [previous] = await transaction
      .select()
      .from(conversationSummaries)
      .where(eq(conversationSummaries.conversationId, input.conversationId));
    if (
      (previous?.version ?? 0) !== input.expectedVersion ||
      input.coveredThroughSequence <= (previous?.coveredThroughSequence ?? -1)
    ) {
      throw new Error("SUMMARY_SAVE_CONFLICT: 摘要边界已变化");
    }
    const [boundary] = await transaction
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.id, input.coveredThroughMessageId),
          eq(messages.conversationId, input.conversationId),
          eq(messages.sequence, input.coveredThroughSequence),
        ),
      );
    // 至少保留最近一个历史 user 轮次以及当前 user 轮次，重新生成不会碰到摘要边界。
    const tailUsers = await transaction
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, input.conversationId),
          eq(messages.role, "user"),
          gt(messages.sequence, input.coveredThroughSequence),
        ),
      )
      .orderBy(desc(messages.sequence))
      .limit(2);
    const [next] = await transaction
      .select({ role: messages.role })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, input.conversationId),
          gt(messages.sequence, input.coveredThroughSequence),
        ),
      )
      .orderBy(messages.sequence)
      .limit(1);
    if (
      !boundary ||
      next?.role !== "user" ||
      tailUsers.length !== 2 ||
      tailUsers[0]?.id !== generation.userMessageId
    ) {
      throw new Error("SUMMARY_SAVE_CONFLICT: 不是可压缩的完整历史轮次");
    }
    const { expectedVersion, ...values } = input;
    const replacement = {
      ...values,
      version: expectedVersion + 1,
      updatedAt: new Date(),
    };
    const [saved] = await transaction
      .insert(conversationSummaries)
      .values(replacement)
      .onConflictDoUpdate({
        target: conversationSummaries.conversationId,
        set: replacement,
      })
      .returning();
    return saved!;
  });
}
