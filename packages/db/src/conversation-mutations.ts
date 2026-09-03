import { and, eq, inArray } from "drizzle-orm";

import { getDatabase } from "./client";
import {
  attachments,
  conversations,
  generations,
  messages,
} from "./schema/index";
import type { ConversationRecord } from "./conversation-reader";

type Database = ReturnType<typeof getDatabase>;

export type DeletedConversationRecord = {
  conversationId: string;
  activeGenerations: Array<{
    id: string;
    status: "queued" | "running";
  }>;
  attachmentObjectKeys: string[];
};

export async function setConversationPinnedForOwner(
  input: {
    ownerId: string;
    conversationId: string;
    pinned: boolean;
    now: Date;
  },
  database: Database = getDatabase(),
): Promise<ConversationRecord | null> {
  const [conversation] = await database
    .update(conversations)
    .set({
      pinnedAt: input.pinned ? input.now : null,
      // 置顶属于列表组织，不应改变“最近对话”的活跃时间。
      updatedAt: conversations.updatedAt,
    })
    .where(
      and(
        eq(conversations.id, input.conversationId),
        eq(conversations.ownerId, input.ownerId),
      ),
    )
    .returning({
      id: conversations.id,
      mode: conversations.mode,
      title: conversations.title,
      pinnedAt: conversations.pinnedAt,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
    });

  return conversation ?? null;
}

export async function deleteConversationRecordForOwner(
  ownerId: string,
  conversationId: string,
  database: Database = getDatabase(),
): Promise<DeletedConversationRecord | null> {
  return database.transaction(async (transaction) => {
    const [conversation] = await transaction
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.ownerId, ownerId),
        ),
      )
      .for("update")
      .limit(1);

    if (!conversation) {
      return null;
    }

    const activeGenerations = await transaction
      .select({ id: generations.id, status: generations.status })
      .from(generations)
      .where(
        and(
          eq(generations.conversationId, conversationId),
          inArray(generations.status, ["queued", "running"]),
        ),
      );
    const messageRows = await transaction
      .select({ parts: messages.parts })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    const attachmentIds = [
      ...new Set(
        messageRows.flatMap(({ parts }) =>
          parts.flatMap((part) =>
            part.type === "attachment" ? [part.attachmentId] : [],
          ),
        ),
      ),
    ];
    const deletedAttachments =
      attachmentIds.length === 0
        ? []
        : await transaction
            .delete(attachments)
            .where(
              and(
                eq(attachments.ownerId, ownerId),
                inArray(attachments.id, attachmentIds),
              ),
            )
            .returning({ objectKey: attachments.objectKey });

    await transaction
      .delete(conversations)
      .where(eq(conversations.id, conversationId));

    const activeGenerationRecords: DeletedConversationRecord["activeGenerations"] = [];
    for (const generation of activeGenerations) {
      if (generation.status === "queued" || generation.status === "running") {
        activeGenerationRecords.push({
          id: generation.id,
          status: generation.status,
        });
      }
    }

    return {
      conversationId,
      activeGenerations: activeGenerationRecords,
      attachmentObjectKeys: deletedAttachments.map(
        (attachment) => attachment.objectKey,
      ),
    };
  });
}
