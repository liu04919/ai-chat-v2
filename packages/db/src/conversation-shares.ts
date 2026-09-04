import type {
  AssistantMessagePartsDto,
  AssistantMessageViewPartsDto,
  ConversationShareSnapshotDto,
  MessageDto,
} from "@ai-chat/contracts";
import {
  assistantMessagePartsSchema,
  conversationShareSnapshotSchema,
  userMessagePartsSchema,
} from "@ai-chat/contracts";
import { and, asc, eq, inArray } from "drizzle-orm";

import { getDatabase } from "./client";
import {
  attachments,
  conversations,
  conversationShares,
  generations,
  messages,
} from "./schema/index";

type Database = ReturnType<typeof getDatabase>;

export type ConversationShareRecord = {
  id: string;
  conversationId: string;
  token: string;
  title: string;
  snapshot: ConversationShareSnapshotDto;
  createdAt: Date;
};

export type ConversationShareAttachmentRecord = {
  objectKey: string;
  originalName: string;
  mediaType: string;
};

export type CreateConversationShareResult =
  | { kind: "created" | "existing"; share: ConversationShareRecord }
  | { kind: "conversation_not_found" }
  | { kind: "active_generation" }
  | { kind: "empty_conversation" };

export type ConversationShareStatusRecordResult =
  | { kind: "found"; share: ConversationShareRecord | null }
  | { kind: "conversation_not_found" };

function toAssistantViewParts(
  parts: AssistantMessagePartsDto,
): AssistantMessageViewPartsDto {
  return parts.map((part) => {
    switch (part.type) {
      case "reasoning":
      case "text":
      case "attachment":
        return part;
      case "tool-call":
        return {
          id: part.id,
          type: part.type,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
        };
      case "tool-result":
        return {
          id: part.id,
          type: part.type,
          toolCallId: part.toolCallId,
          isError: part.isError,
        };
    }
  });
}

function parseShareRecord(
  record: Omit<ConversationShareRecord, "snapshot"> & { snapshot: unknown },
): ConversationShareRecord {
  return {
    ...record,
    snapshot: conversationShareSnapshotSchema.parse(record.snapshot),
  };
}

export async function getConversationShareRecordForOwner(
  ownerId: string,
  conversationId: string,
  database: Database = getDatabase(),
): Promise<ConversationShareStatusRecordResult> {
  const [record] = await database
    .select({
      conversationId: conversations.id,
      shareId: conversationShares.id,
      shareConversationId: conversationShares.conversationId,
      shareToken: conversationShares.token,
      shareTitle: conversationShares.title,
      shareSnapshot: conversationShares.snapshot,
      shareCreatedAt: conversationShares.createdAt,
    })
    .from(conversations)
    .leftJoin(
      conversationShares,
      eq(conversations.id, conversationShares.conversationId),
    )
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.ownerId, ownerId),
      ),
    )
    .limit(1);

  if (!record) {
    return { kind: "conversation_not_found" };
  }

  if (
    !record.shareId ||
    !record.shareConversationId ||
    !record.shareToken ||
    !record.shareTitle ||
    !record.shareSnapshot ||
    !record.shareCreatedAt
  ) {
    return { kind: "found", share: null };
  }

  return {
    kind: "found",
    share: parseShareRecord({
      id: record.shareId,
      conversationId: record.shareConversationId,
      token: record.shareToken,
      title: record.shareTitle,
      snapshot: record.shareSnapshot,
      createdAt: record.shareCreatedAt,
    }),
  };
}

export async function createConversationShareRecordForOwner(
  input: {
    id: string;
    token: string;
    ownerId: string;
    conversationId: string;
    now: Date;
  },
  database: Database = getDatabase(),
): Promise<CreateConversationShareResult> {
  return database.transaction(async (transaction) => {
    const [conversation] = await transaction
      .select({ id: conversations.id, title: conversations.title })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.ownerId, input.ownerId),
        ),
      )
      .for("update")
      .limit(1);

    if (!conversation) {
      return { kind: "conversation_not_found" };
    }

    const [existing] = await transaction
      .select()
      .from(conversationShares)
      .where(eq(conversationShares.conversationId, conversation.id))
      .limit(1);

    if (existing) {
      return { kind: "existing", share: parseShareRecord(existing) };
    }

    const [activeGeneration] = await transaction
      .select({ id: generations.id })
      .from(generations)
      .where(
        and(
          eq(generations.conversationId, conversation.id),
          inArray(generations.status, ["queued", "running"]),
        ),
      )
      .limit(1);

    if (activeGeneration) {
      return { kind: "active_generation" };
    }

    const rawMessages = await transaction
      .select({
        id: messages.id,
        role: messages.role,
        parts: messages.parts,
        sequence: messages.sequence,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.conversationId, conversation.id))
      .orderBy(asc(messages.sequence));

    if (rawMessages.length === 0) {
      return { kind: "empty_conversation" };
    }

    const snapshotMessages: MessageDto[] = rawMessages.map((message) =>
      message.role === "user"
        ? {
            id: message.id,
            role: "user",
            sequence: message.sequence,
            parts: userMessagePartsSchema.parse(message.parts),
            createdAt: message.createdAt.toISOString(),
          }
        : {
            id: message.id,
            role: "assistant",
            sequence: message.sequence,
            parts: toAssistantViewParts(
              assistantMessagePartsSchema.parse(message.parts),
            ),
            createdAt: message.createdAt.toISOString(),
          },
    );
    const attachmentIds = [
      ...new Set(
        snapshotMessages.flatMap((message) =>
          message.parts.flatMap((part) =>
            part.type === "attachment" ? [part.attachmentId] : [],
          ),
        ),
      ),
    ];
    const attachmentRecords =
      attachmentIds.length === 0
        ? []
        : await transaction
            .select({
              id: attachments.id,
              originalName: attachments.originalName,
              mediaType: attachments.mediaType,
              sizeBytes: attachments.sizeBytes,
            })
            .from(attachments)
            .where(
              and(
                eq(attachments.ownerId, input.ownerId),
                eq(attachments.status, "ready"),
                inArray(attachments.id, attachmentIds),
              ),
            );

    if (attachmentRecords.length !== attachmentIds.length) {
      throw new Error("Conversation Share 引用的 Attachment 不完整");
    }

    const snapshot = conversationShareSnapshotSchema.parse({
      version: 1,
      messages: snapshotMessages,
      attachments: attachmentRecords,
    });
    const [created] = await transaction
      .insert(conversationShares)
      .values({
        id: input.id,
        conversationId: conversation.id,
        token: input.token,
        title: conversation.title,
        snapshot,
        createdAt: input.now,
      })
      .returning();

    if (!created) {
      throw new Error("创建 Conversation Share 后数据库没有返回记录");
    }

    return { kind: "created", share: parseShareRecord(created) };
  });
}

export async function deleteConversationShareRecordForOwner(
  ownerId: string,
  conversationId: string,
  database: Database = getDatabase(),
): Promise<boolean> {
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
      return false;
    }

    await transaction
      .delete(conversationShares)
      .where(eq(conversationShares.conversationId, conversation.id));
    return true;
  });
}

export async function getConversationShareRecordByToken(
  token: string,
  database: Database = getDatabase(),
): Promise<ConversationShareRecord | null> {
  const [record] = await database
    .select()
    .from(conversationShares)
    .where(eq(conversationShares.token, token))
    .limit(1);

  return record ? parseShareRecord(record) : null;
}

export async function getConversationShareAttachmentRecord(
  token: string,
  attachmentId: string,
  database: Database = getDatabase(),
): Promise<ConversationShareAttachmentRecord | null> {
  const [record] = await database
    .select({
      snapshot: conversationShares.snapshot,
      objectKey: attachments.objectKey,
      originalName: attachments.originalName,
      mediaType: attachments.mediaType,
    })
    .from(conversationShares)
    .innerJoin(
      conversations,
      eq(conversations.id, conversationShares.conversationId),
    )
    .innerJoin(
      attachments,
      and(
        eq(attachments.id, attachmentId),
        eq(attachments.ownerId, conversations.ownerId),
      ),
    )
    .where(eq(conversationShares.token, token))
    .limit(1);

  if (!record) {
    return null;
  }

  const snapshot = conversationShareSnapshotSchema.parse(record.snapshot);
  return snapshot.attachments.some((attachment) => attachment.id === attachmentId)
    ? {
        objectKey: record.objectKey,
        originalName: record.originalName,
        mediaType: record.mediaType,
      }
    : null;
}
