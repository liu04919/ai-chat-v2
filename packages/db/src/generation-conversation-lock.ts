import { eq } from "drizzle-orm";

import type { getDatabase } from "./client";
import { conversations, generations } from "./schema/index";

type Transaction = Parameters<Parameters<ReturnType<typeof getDatabase>["transaction"]>[0]>[0];

/** 与删除、发送、重新生成一致：先锁父会话，再锁 Generation 或写入消息。 */
export async function lockGenerationConversation(transaction: Transaction, generationId: string) {
  const [conversation] = await transaction
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, transaction.select({ id: generations.conversationId })
      .from(generations).where(eq(generations.id, generationId)).limit(1)))
    .for("update")
    .limit(1);
  // 等锁期间会话可能已删除；调用方应放弃本次写入。
  return Boolean(conversation);
}
