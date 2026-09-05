import type {
  CreateGenerationRequest,
  GenerationToolSelectionDto,
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
  tools: GenerationToolSelectionDto;
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

// 事务回调正常 return 会提交。校验失败先抛出以回滚，再在事务外恢复业务返回值。
class GenerationCommandRejected extends Error {
  constructor(readonly result: Exclude<
    CreateGenerationCommandRecordResult,
    { kind: "created" | "idempotent" }
  >) {
    super(result.kind);
  }
}

type ExistingCommandRow = {
  ownerId: string;
  conversationId: string;
  conversationMode: "chat" | "image";
  parts: UserMessagePartsDto;
  generationId: string | null;
  generationStatus: GenerationStatusDto | null;
  reasoningEffort: ReasoningEffortDto | null;
  webSearchEnabled: boolean | null;
  mcpToolIds: string[] | null;
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
  database: Pick<Database, "select">,
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
      webSearchEnabled: generations.webSearchEnabled,
      mcpToolIds: generations.mcpToolIds,
      generationCreatedAt: generations.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .leftJoin(
      generations,
      eq(generations.userMessageId, messages.id),
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
    existing.reasoningEffort !== input.reasoningEffort ||
    existing.webSearchEnabled !== input.tools.webSearch ||
    !existing.mcpToolIds ||
    existing.mcpToolIds.length !== input.tools.mcpToolIds.length ||
    existing.mcpToolIds.some(
      (toolId, index) => toolId !== input.tools.mcpToolIds[index],
    ) ||
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
      tools: {
        webSearch: existing.webSearchEnabled,
        mcpToolIds: existing.mcpToolIds,
      },
      createdAt: existing.generationCreatedAt,
    },
  };
}

function isPostgresConstraintError(
  error: unknown,
  constraintName: string,
): boolean {
  // DrizzleQueryError 将 postgres-js 的错误保存在 cause 中。
  if (error instanceof Error && error.cause) {
    return isPostgresConstraintError(error.cause, constraintName);
  }
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
          throw new GenerationCommandRejected({ kind: "conversation_not_found" });
        }

        conversation = existingConversation;
      }

      // 等待会话锁时，相同请求可能已经提交，必须先检查幂等再检查活跃任务。
      const concurrentExisting = await findExistingCommand(input.userMessageId, transaction);
      if (concurrentExisting) {
        const result = resolveExistingCommand(concurrentExisting, input);
        if (result.kind === "message_id_conflict") throw new GenerationCommandRejected(result);
        return result;
      }

      if (
        (conversation.mode === "chat" && input.reasoningEffort === null) ||
        (conversation.mode === "image" &&
          (input.reasoningEffort !== null ||
            input.tools.webSearch ||
            input.tools.mcpToolIds.length > 0))
      ) {
        throw new GenerationCommandRejected({ kind: "invalid_request" });
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
        throw new GenerationCommandRejected({ kind: "invalid_request" });
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
        throw new GenerationCommandRejected({
          kind: "active_generation",
          activeGenerationId: activeGeneration.id,
        });
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
            throw new GenerationCommandRejected({ kind: "attachment_not_found", attachmentId });
          }

          if (attachment.status !== "ready") {
            throw new GenerationCommandRejected({ kind: "attachment_not_ready", attachmentId });
          }

          if (attachment.linkedAt) {
            throw new GenerationCommandRejected({ kind: "attachment_in_use", attachmentId });
          }

          if (
            conversation.mode === "image" &&
            !attachment.mediaType.startsWith("image/")
          ) {
            throw new GenerationCommandRejected({ kind: "attachment_mode_mismatch", attachmentId });
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
          webSearchEnabled: input.tools.webSearch,
          mcpToolIds: input.tools.mcpToolIds,
          createdAt: input.now,
        })
        .returning({
          id: generations.id,
          conversationId: generations.conversationId,
          userMessageId: generations.userMessageId,
          status: generations.status,
          reasoningEffort: generations.reasoningEffort,
          webSearchEnabled: generations.webSearchEnabled,
          mcpToolIds: generations.mcpToolIds,
          createdAt: generations.createdAt,
        });

      if (!generation) {
        throw new Error("创建 Generation 后数据库没有返回记录");
      }

      const { webSearchEnabled, mcpToolIds, ...generationRecord } =
        generation;

      await transaction
        .update(conversations)
        .set({ updatedAt: input.now })
        .where(eq(conversations.id, conversation.id));

      return {
        kind: "created",
        generation: {
          ...generationRecord,
          tools: {
            webSearch: webSearchEnabled,
            mcpToolIds,
          },
        },
      };
    });
  } catch (error) {
    if (error instanceof GenerationCommandRejected) {
      return error.result;
    }
    if (
      isPostgresConstraintError(error, "messages_pkey") ||
      isPostgresConstraintError(error, "conversations_pkey")
    ) {
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
