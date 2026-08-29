import type {
  AttachmentMediaType,
  AttachmentStatusDto,
  MessagePartsDto,
  ReasoningEffortDto,
} from "@ai-chat/contracts";
import { and, asc, eq, inArray, max } from "drizzle-orm";

import { getDatabase } from "./client";
import {
  attachments,
  conversations,
  generations,
  messages,
} from "./schema/index";

type Database = ReturnType<typeof getDatabase>;

export type GenerationExecutionMessageRecord = {
  id: string;
  role: "user" | "assistant";
  parts: MessagePartsDto;
  sequence: number;
};

export type GenerationExecutionAttachmentRecord = {
  id: string;
  objectKey: string;
  originalName: string;
  mediaType: AttachmentMediaType;
  status: AttachmentStatusDto;
};

export type ClaimedGenerationExecution = {
  id: string;
  conversationId: string;
  ownerId: string;
  mode: "chat" | "image";
  reasoningEffort: ReasoningEffortDto | null;
  messages: GenerationExecutionMessageRecord[];
  attachments: GenerationExecutionAttachmentRecord[];
};

export type ClaimGenerationExecutionResult =
  | { kind: "claimed"; execution: ClaimedGenerationExecution }
  | { kind: "not_queued" };

function assertNonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} 不能为空`);
  }

  return value;
}

export async function claimGenerationExecution(
  generationId: string,
  now: Date,
  database: Database = getDatabase(),
): Promise<ClaimGenerationExecutionResult> {
  assertNonEmpty(generationId, "generationId");

  return database.transaction(async (transaction) => {
    const [claimed] = await transaction
      .update(generations)
      .set({
        status: "running",
        startedAt: now,
        errorCode: null,
      })
      .where(
        and(
          eq(generations.id, generationId),
          eq(generations.status, "queued"),
        ),
      )
      .returning({
        id: generations.id,
        conversationId: generations.conversationId,
        reasoningEffort: generations.reasoningEffort,
      });

    if (!claimed) {
      return { kind: "not_queued" };
    }

    const [conversation] = await transaction
      .select({
        ownerId: conversations.ownerId,
        mode: conversations.mode,
      })
      .from(conversations)
      .where(eq(conversations.id, claimed.conversationId))
      .limit(1);

    if (!conversation) {
      throw new Error("Generation 对应的 Conversation 不存在");
    }

    const messageRecords = await transaction
      .select({
        id: messages.id,
        role: messages.role,
        parts: messages.parts,
        sequence: messages.sequence,
      })
      .from(messages)
      .where(eq(messages.conversationId, claimed.conversationId))
      .orderBy(asc(messages.sequence));
    const attachmentIds = [
      ...new Set(
        messageRecords.flatMap((message) =>
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
              objectKey: attachments.objectKey,
              originalName: attachments.originalName,
              mediaType: attachments.mediaType,
              status: attachments.status,
            })
            .from(attachments)
            .where(
              and(
                eq(attachments.ownerId, conversation.ownerId),
                inArray(attachments.id, attachmentIds),
              ),
            );

    return {
      kind: "claimed",
      execution: {
        id: claimed.id,
        conversationId: claimed.conversationId,
        ownerId: conversation.ownerId,
        mode: conversation.mode,
        reasoningEffort: claimed.reasoningEffort,
        messages: messageRecords,
        attachments: attachmentRecords,
      },
    };
  });
}

export async function completeGenerationExecution(
  input: {
    generationId: string;
    assistantMessageId: string;
    assistantText: string;
    now: Date;
  },
  database: Database = getDatabase(),
): Promise<boolean> {
  assertNonEmpty(input.generationId, "generationId");
  assertNonEmpty(input.assistantMessageId, "assistantMessageId");

  if (input.assistantText.trim().length === 0) {
    throw new TypeError("assistantText 不能为空");
  }

  return database.transaction(async (transaction) => {
    const [generation] = await transaction
      .select({
        conversationId: generations.conversationId,
        status: generations.status,
      })
      .from(generations)
      .where(eq(generations.id, input.generationId))
      .for("update")
      .limit(1);

    if (!generation || generation.status !== "running") {
      return false;
    }

    const [sequenceRow] = await transaction
      .select({ sequence: max(messages.sequence) })
      .from(messages)
      .where(eq(messages.conversationId, generation.conversationId));
    const nextSequence = Number(sequenceRow?.sequence ?? -1) + 1;

    await transaction.insert(messages).values({
      id: input.assistantMessageId,
      conversationId: generation.conversationId,
      role: "assistant",
      parts: [{ type: "text", text: input.assistantText }],
      sequence: nextSequence,
      createdAt: input.now,
    });
    await transaction
      .update(generations)
      .set({
        status: "completed",
        assistantMessageId: input.assistantMessageId,
        finishedAt: input.now,
        errorCode: null,
      })
      .where(eq(generations.id, input.generationId));
    await transaction
      .update(conversations)
      .set({ updatedAt: input.now })
      .where(eq(conversations.id, generation.conversationId));

    return true;
  });
}

export async function failGenerationExecution(
  input: {
    generationId: string;
    errorCode: string;
    now: Date;
  },
  database: Database = getDatabase(),
): Promise<boolean> {
  assertNonEmpty(input.generationId, "generationId");
  assertNonEmpty(input.errorCode, "errorCode");

  const [failed] = await database
    .update(generations)
    .set({
      status: "failed",
      errorCode: input.errorCode,
      finishedAt: input.now,
    })
    .where(
      and(
        eq(generations.id, input.generationId),
        eq(generations.status, "running"),
      ),
    )
    .returning({ id: generations.id });

  return Boolean(failed);
}
