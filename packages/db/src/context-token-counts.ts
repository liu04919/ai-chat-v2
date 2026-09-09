import type {
  AttachmentTokenCount,
  MessageTokenCount,
} from "@ai-chat/model-context";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDatabase } from "./client";
import { attachments, conversations, messages } from "./schema/index";

type Database = ReturnType<typeof getDatabase>;

/** 计数规则升级时按需刷新缓存；不改消息内容，也不更新会话时间。 */
export async function saveMessageTokenCounts(
  input: {
    ownerId: string;
    conversationId: string;
    counts: { id: string; count: MessageTokenCount }[];
  },
  database: Database = getDatabase(),
): Promise<void> {
  if (!input.counts.length) return;
  const cases = input.counts.map(
    ({ id, count }) => sql`when ${id} then ${JSON.stringify(count)}::jsonb`,
  );
  await database
    .update(messages)
    .set({
      contextTokenCount: sql`case ${messages.id} ${sql.join(cases, sql` `)} end`,
    })
    .where(
      and(
        inArray(
          messages.id,
          input.counts.map((item) => item.id),
        ),
        eq(messages.conversationId, input.conversationId),
        inArray(
          messages.conversationId,
          database
            .select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.ownerId, input.ownerId)),
        ),
      ),
    );
}

export async function saveAttachmentTokenCount(
  input: {
    ownerId: string;
    attachmentId: string;
    count: AttachmentTokenCount;
  },
  database: Database = getDatabase(),
): Promise<void> {
  await database
    .update(attachments)
    .set({ contextTokenCount: input.count })
    .where(
      and(
        eq(attachments.id, input.attachmentId),
        eq(attachments.ownerId, input.ownerId),
        eq(attachments.status, "ready"),
      ),
    );
}
