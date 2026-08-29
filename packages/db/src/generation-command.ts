import type {
  CreateGenerationRequest,
  GenerationStatusDto,
  ReasoningEffortDto,
  UserMessagePartsDto,
} from "@ai-chat/contracts";
import { userMessagePartsSchema } from "@ai-chat/contracts";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  max,
} from "drizzle-orm";

import { getDatabase } from "./client";
import {
  attachments,
  conversations,
  generations,
  messages,
} from "./schema/index";

type Database = ReturnType<typeof getDatabase>;

export type GenerationCommandRecord = {
  id: string;
  conversationId: string;
  userMessageId: string;
  status: GenerationStatusDto;
  reasoningEffort: ReasoningEffortDto | null;
  createdAt: Date;
};

export type CreateGenerationCommandRecordResult =
  | { kind: "created"; generation: GenerationCommandRecord }
  | { kind: "idempotent"; generation: GenerationCommandRecord }
  | { kind: "conversation_not_found" }
  | { kind: "message_id_conflict" }
  | { kind: "active_generation"; activeGenerationId: string }
  | { kind: "attachment_not_found"; attachmentId: string }
  | { kind: "attachment_not_ready"; attachmentId: string }
  | { kind: "attachment_in_use"; attachmentId: string }
  | { kind: "attachment_mode_mismatch"; attachmentId: string }
  | { kind: "invalid_request" };

export type CreateGenerationCommandRecordInput = CreateGenerationRequest & {
  ownerId: string;
  generationId: string;
  conversationTitle: string;
  now: Date;
};

type ExistingCommandRow = {
  ownerId: string;
  conversationId: string;
  conversationMode: "chat" | "image";
  parts: UserMessagePartsDto;
  generationId: string | null;
  generationStatus: GenerationStatusDto | null;
  reasoningEffort: ReasoningEffortDto | null;
  generationCreatedAt: Date | null;
};

function messagePartsEqual(
  left: UserMessagePartsDto,
  right: UserMessagePartsDto,
): boolean {
  return (
    left.length === right.length &&
    left.every((part, index) => {
      const other = right[index];

      if (!other || part.type !== other.type) {
        return false;
      }

      return part.type === "text"
        ? other.type === "text" && part.text === other.text
        : other.type === "attachment" &&
            part.attachmentId === other.attachmentId;
    })
  );
}

async function findExistingCommand(
  userMessageId: string,
  database: Database,
): Promise<ExistingCommandRow | null> {
  const [row] = await database
    .select({
      ownerId: conversations.ownerId,
      conversationId: conversations.id,
      conversationMode: conversations.mode,
      parts: messages.parts,
      generationId: generations.id,
      generationStatus: generations.status,
      reasoningEffort: generations.reasoningEffort,
      generationCreatedAt: generations.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .leftJoin(
      generations,
      and(
        eq(generations.userMessageId, messages.id),
        isNull(generations.replacesAssistantMessageId),
      ),
    )
    .where(and(eq(messages.id, userMessageId), eq(messages.role, "user")))
    .orderBy(asc(generations.createdAt))
    .limit(1);

  return row
    ? { ...row, parts: userMessagePartsSchema.parse(row.parts) }
    : null;
}

function resolveExistingCommand(
  existing: ExistingCommandRow,
  input: CreateGenerationCommandRecordInput,
): CreateGenerationCommandRecordResult {
  const targetMatches =
    input.target.type === "new"
      ? input.target.conversationId === existing.conversationId &&
        input.target.mode === existing.conversationMode
      : input.target.conversationId === existing.conversationId;

  if (
    existing.ownerId !== input.ownerId ||
    !targetMatches ||
    !messagePartsEqual(existing.parts, input.parts) ||
    !existing.generationId ||
    !existing.generationStatus ||
    !existing.generationCreatedAt
  ) {
    return { kind: "message_id_conflict" };
  }

  return {
    kind: "idempotent",
    generation: {
      id: existing.generationId,
      conversationId: existing.conversationId,
      userMessageId: input.userMessageId,
      status: existing.generationStatus,
      reasoningEffort: existing.reasoningEffort,
      createdAt: existing.generationCreatedAt,
    },
  };
}

function isPostgresConstraintError(
  error: unknown,
  constraintName: string,
): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint_name" in error &&
    error.constraint_name === constraintName
  );
}

export async function createGenerationCommandRecord(
  input: CreateGenerationCommandRecordInput,
  database: Database = getDatabase(),
): Promise<CreateGenerationCommandRecordResult> {
  const existing = await findExistingCommand(input.userMessageId, database);

  if (existing) {
    return resolveExistingCommand(existing, input);
  }

  try {
    return await database.transaction(async (transaction) => {
      let conversation: {
        id: string;
        mode: "chat" | "image";
      };

      if (input.target.type === "new") {
        const [createdConversation] = await transaction
          .insert(conversations)
          .values({
            id: input.target.conversationId,
            ownerId: input.ownerId,
            mode: input.target.mode,
            title: input.conversationTitle,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .returning({ id: conversations.id, mode: conversations.mode });

        if (!createdConversation) {
          throw new Error("创建 Conversation 后数据库没有返回记录");
        }

        conversation = createdConversation;
      } else {
        const [existingConversation] = await transaction
          .select({ id: conversations.id, mode: conversations.mode })
          .from(conversations)
          .where(
            and(
              eq(conversations.id, input.target.conversationId),
              eq(conversations.ownerId, input.ownerId),
            ),
          )
          .for("update")
          .limit(1);

        if (!existingConversation) {
          return { kind: "conversation_not_found" };
        }

        conversation = existingConversation;
      }

      if (
        (conversation.mode === "chat" && input.reasoningEffort === null) ||
        (conversation.mode === "image" && input.reasoningEffort !== null)
      ) {
        return { kind: "invalid_request" };
      }

      const textParts = input.parts.filter((part) => part.type === "text");
      const attachmentIds = input.parts.flatMap((part) =>
        part.type === "attachment" ? [part.attachmentId] : [],
      );

      if (
        conversation.mode === "image" &&
        (textParts.length !== 1 ||
          textParts[0]?.text.trim().length === 0 ||
          attachmentIds.length > 1)
      ) {
        return { kind: "invalid_request" };
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
        return {
          kind: "active_generation",
          activeGenerationId: activeGeneration.id,
        };
      }

      if (attachmentIds.length > 0) {
        const attachmentRows = await transaction
          .select({
            id: attachments.id,
            mediaType: attachments.mediaType,
            status: attachments.status,
            linkedAt: attachments.linkedAt,
          })
          .from(attachments)
          .where(
            and(
              eq(attachments.ownerId, input.ownerId),
              inArray(attachments.id, attachmentIds),
            ),
          )
          .for("update");
        const attachmentsById = new Map(
          attachmentRows.map((attachment) => [attachment.id, attachment]),
        );

        for (const attachmentId of attachmentIds) {
          const attachment = attachmentsById.get(attachmentId);

          if (!attachment) {
            return { kind: "attachment_not_found", attachmentId };
          }

          if (attachment.status !== "ready") {
            return { kind: "attachment_not_ready", attachmentId };
          }

          if (attachment.linkedAt) {
            return { kind: "attachment_in_use", attachmentId };
          }

          if (
            conversation.mode === "image" &&
            !attachment.mediaType.startsWith("image/")
          ) {
            return { kind: "attachment_mode_mismatch", attachmentId };
          }
        }
      }

      const [sequenceRow] = await transaction
        .select({ sequence: max(messages.sequence) })
        .from(messages)
        .where(eq(messages.conversationId, conversation.id));
      const nextSequence = Number(sequenceRow?.sequence ?? -1) + 1;

      await transaction.insert(messages).values({
        id: input.userMessageId,
        conversationId: conversation.id,
        role: "user",
        parts: input.parts,
        sequence: nextSequence,
        createdAt: input.now,
      });

      if (attachmentIds.length > 0) {
        await transaction
          .update(attachments)
          .set({ linkedAt: input.now, updatedAt: input.now })
          .where(
            and(
              eq(attachments.ownerId, input.ownerId),
              inArray(attachments.id, attachmentIds),
              isNull(attachments.linkedAt),
            ),
          );
      }

      const [generation] = await transaction
        .insert(generations)
        .values({
          id: input.generationId,
          conversationId: conversation.id,
          userMessageId: input.userMessageId,
          status: "queued",
          reasoningEffort: input.reasoningEffort,
          createdAt: input.now,
        })
        .returning({
          id: generations.id,
          conversationId: generations.conversationId,
          userMessageId: generations.userMessageId,
          status: generations.status,
          reasoningEffort: generations.reasoningEffort,
          createdAt: generations.createdAt,
        });

      if (!generation) {
        throw new Error("创建 Generation 后数据库没有返回记录");
      }

      await transaction
        .update(conversations)
        .set({ updatedAt: input.now })
        .where(eq(conversations.id, conversation.id));

      return { kind: "created", generation };
    });
  } catch (error) {
    if (isPostgresConstraintError(error, "messages_pkey")) {
      const concurrentExisting = await findExistingCommand(
        input.userMessageId,
        database,
      );

      return concurrentExisting
        ? resolveExistingCommand(concurrentExisting, input)
        : { kind: "message_id_conflict" };
    }

    if (
      isPostgresConstraintError(
        error,
        "generations_one_active_per_conversation",
      )
    ) {
      const [activeGeneration] = await database
        .select({ id: generations.id })
        .from(generations)
        .where(
          and(
            eq(generations.conversationId, input.target.conversationId),
            inArray(generations.status, ["queued", "running"]),
          ),
        )
        .limit(1);

      if (activeGeneration) {
        return {
          kind: "active_generation",
          activeGenerationId: activeGeneration.id,
        };
      }
    }

    throw error;
  }
}
