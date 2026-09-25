import type {
  AssistantMessagePartsDto,
  AttachmentMediaType,
  AttachmentStatusDto,
  GenerationToolSelectionDto,
  ReasoningEffortDto,
  UserMessagePartsDto,
} from "@ai-chat/contracts";
import {
  assistantMessagePartsSchema,
  userMessagePartsSchema,
} from "@ai-chat/contracts";
import {
  countStoredMessage,
  type MessageTokenCount,
  type AttachmentTokenCount,
} from "@ai-chat/model-context";
import { and, asc, eq, gt, inArray, isNull, max } from "drizzle-orm";

import { getDatabase } from "../client";
import type { ConversationSummaryRecord } from "../conversations/summary";
import { lockGenerationConversation } from "./conversation-lock";
import {
  attachments,
  conversations,
  conversationSummaries,
  generations,
  messages,
} from "../schema/index";

type Database = ReturnType<typeof getDatabase>;

type GenerationExecutionMessageBase = {
  id: string;
  sequence: number;
  contextTokenCount?: MessageTokenCount | null;
};

export type GenerationExecutionMessageRecord =
  | (GenerationExecutionMessageBase & {
      role: "user";
      parts: UserMessagePartsDto;
    })
  | (GenerationExecutionMessageBase & {
      role: "assistant";
      parts: AssistantMessagePartsDto;
    });

export type GenerationExecutionAttachmentRecord = {
  id: string;
  objectKey: string;
  originalName: string;
  mediaType: AttachmentMediaType;
  status: AttachmentStatusDto;
  contextTokenCount?: AttachmentTokenCount | null;
};

export type ClaimedGenerationExecution = {
  id: string;
  userMessageId: string;
  conversationId: string;
  ownerId: string;
  mode: "chat" | "image";
  reasoningEffort: ReasoningEffortDto | null;
  tools: GenerationToolSelectionDto;
  knowledgeBaseId?: string | null;
  messages: GenerationExecutionMessageRecord[];
  attachments: GenerationExecutionAttachmentRecord[];
  summary: ConversationSummaryRecord | null;
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
    if (!await lockGenerationConversation(transaction, generationId)) {
      return { kind: "not_queued" };
    }
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
          isNull(generations.cancelRequestedAt),
        ),
      )
      .returning({
        id: generations.id,
        userMessageId: generations.userMessageId,
        conversationId: generations.conversationId,
        reasoningEffort: generations.reasoningEffort,
        webSearchEnabled: generations.webSearchEnabled,
        mcpToolIds: generations.mcpToolIds,
        knowledgeBaseId: generations.knowledgeBaseId,
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

    // 摘要和未覆盖原文在同一次领取事务中读取，不能把两个版本的边界混在一起。
    const [summary] = conversation.mode === "chat"
      ? await transaction
          .select()
          .from(conversationSummaries)
          .where(eq(conversationSummaries.conversationId, claimed.conversationId))
      : [];
    const rawMessageRecords = await transaction
      .select({
        id: messages.id,
        role: messages.role,
        parts: messages.parts,
        sequence: messages.sequence,
        contextTokenCount: messages.contextTokenCount,
      })
      .from(messages)
      .where(and(
        eq(messages.conversationId, claimed.conversationId),
        summary ? gt(messages.sequence, summary.coveredThroughSequence) : undefined,
      ))
      .orderBy(asc(messages.sequence));
    const messageRecords: GenerationExecutionMessageRecord[] =
      rawMessageRecords
        .map((message) =>
          message.role === "user"
            ? {
                id: message.id,
                role: "user",
                parts: userMessagePartsSchema.parse(message.parts),
                sequence: message.sequence,
                contextTokenCount: message.contextTokenCount,
              }
            : {
                id: message.id,
                role: "assistant",
                parts: assistantMessagePartsSchema.parse(message.parts),
                sequence: message.sequence,
                contextTokenCount: message.contextTokenCount,
              },
        );
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
              contextTokenCount: attachments.contextTokenCount,
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
        userMessageId: claimed.userMessageId,
        conversationId: claimed.conversationId,
        ownerId: conversation.ownerId,
        mode: conversation.mode,
        reasoningEffort: claimed.reasoningEffort,
        knowledgeBaseId: claimed.knowledgeBaseId,
        tools: {
          webSearch: claimed.webSearchEnabled,
          mcpToolIds: claimed.mcpToolIds,
        },
        messages: messageRecords,
        attachments: attachmentRecords,
        summary: summary ?? null,
      },
    };
  });
}

export async function completeGenerationExecution(
  input: {
    generationId: string;
    assistantMessageId: string;
    assistantParts: AssistantMessagePartsDto;
    now: Date;
  },
  database: Database = getDatabase(),
): Promise<string | null> {
  assertNonEmpty(input.generationId, "generationId");
  assertNonEmpty(input.assistantMessageId, "assistantMessageId");

  const assistantParts = assistantMessagePartsSchema.parse(
    input.assistantParts,
  );
  const contextTokenCount = countStoredMessage({
    role: "assistant",
    parts: assistantParts,
  });

  if (
    !assistantParts.some(
      (part) => part.type === "text" && part.text.trim().length > 0,
    )
  ) {
    throw new TypeError("Chat Assistant Message 必须包含非空 text part");
  }

  return database.transaction(async (transaction) => {
    if (!await lockGenerationConversation(transaction, input.generationId)) return null;
    const [generation] = await transaction
      .select({
        conversationId: generations.conversationId,
        status: generations.status,
        cancelRequestedAt: generations.cancelRequestedAt,
      })
      .from(generations)
      .where(eq(generations.id, input.generationId))
      .for("update")
      .limit(1);

    if (
      !generation ||
      generation.status !== "running" ||
      generation.cancelRequestedAt
    ) {
      return null;
    }

    const assistantMessageId = input.assistantMessageId;
    const [sequenceRow] = await transaction
      .select({ sequence: max(messages.sequence) })
      .from(messages)
      .where(eq(messages.conversationId, generation.conversationId));
    const nextSequence = Number(sequenceRow?.sequence ?? -1) + 1;

    await transaction.insert(messages).values({
      id: assistantMessageId,
      conversationId: generation.conversationId,
      role: "assistant",
      parts: assistantParts,
      contextTokenCount,
      sequence: nextSequence,
      createdAt: input.now,
    });
    await transaction
      .update(generations)
      .set({
        status: "completed",
        assistantMessageId,
        finishedAt: input.now,
        errorCode: null,
      })
      .where(eq(generations.id, input.generationId));
    await transaction
      .update(conversations)
      .set({ updatedAt: input.now })
      .where(eq(conversations.id, generation.conversationId));

    return assistantMessageId;
  });
}

export async function failGenerationExecution(
  input: {
    generationId: string;
    errorCode: string;
    partialMessage?: {
      id: string;
      parts: AssistantMessagePartsDto;
    };
    now: Date;
  },
  database: Database = getDatabase(),
): Promise<boolean> {
  assertNonEmpty(input.generationId, "generationId");
  assertNonEmpty(input.errorCode, "errorCode");

  const partialMessage = input.partialMessage
    ? {
        id: assertNonEmpty(input.partialMessage.id, "partialMessage.id"),
        parts: assistantMessagePartsSchema.parse(input.partialMessage.parts),
      }
    : null;
  const contextTokenCount = partialMessage
    ? countStoredMessage({ role: "assistant", parts: partialMessage.parts })
    : null;

  return database.transaction(async (transaction) => {
    if (!await lockGenerationConversation(transaction, input.generationId)) return false;
    const [generation] = await transaction
      .select({
        conversationId: generations.conversationId,
        status: generations.status,
        cancelRequestedAt: generations.cancelRequestedAt,
      })
      .from(generations)
      .where(eq(generations.id, input.generationId))
      .for("update")
      .limit(1);

    if (
      !generation ||
      generation.status !== "running" ||
      generation.cancelRequestedAt
    ) {
      return false;
    }

    // 失败不代表已有内容无效：思考、工具过程和引用也随消息保留。
    // 与失败状态一起提交，避免刷新后只有 failed，却丢失已经显示的内容。
    if (partialMessage) {
      const [sequenceRow] = await transaction
        .select({ sequence: max(messages.sequence) })
        .from(messages)
        .where(eq(messages.conversationId, generation.conversationId));
      await transaction.insert(messages).values({
        id: partialMessage.id,
        conversationId: generation.conversationId,
        role: "assistant",
        parts: partialMessage.parts,
        contextTokenCount,
        sequence: Number(sequenceRow?.sequence ?? -1) + 1,
        createdAt: input.now,
      });
    }

    await transaction
      .update(generations)
      .set({
        status: "failed",
        assistantMessageId: partialMessage?.id ?? null,
        errorCode: input.errorCode,
        finishedAt: input.now,
      })
      .where(eq(generations.id, input.generationId));
    await transaction
      .update(conversations)
      .set({ updatedAt: input.now })
      .where(eq(conversations.id, generation.conversationId));

    return true;
  });
}
