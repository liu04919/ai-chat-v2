import type {
  GenerationStatusDto,
  ReasoningEffortDto,
  RegenerateGenerationRequest,
} from "@ai-chat/contracts";
import { and, desc, eq, inArray } from "drizzle-orm";

import { getDatabase } from "./client";
import { conversations, generations, messages } from "./schema/index";

type Database = ReturnType<typeof getDatabase>;

export type RegenerationCommandRecord = {
  id: string;
  conversationId: string;
  userMessageId: string;
  status: GenerationStatusDto;
  reasoningEffort: ReasoningEffortDto;
  createdAt: Date;
};

export type CreateRegenerationCommandRecordResult =
  | { kind: "created"; generation: RegenerationCommandRecord }
  | { kind: "conversation_not_found" }
  | { kind: "assistant_message_not_found" }
  | { kind: "regeneration_not_allowed" }
  | { kind: "active_generation"; activeGenerationId: string };

export type CreateRegenerationCommandRecordInput =
  RegenerateGenerationRequest & {
    ownerId: string;
    generationId: string;
    now: Date;
  };

export async function createRegenerationCommandRecord(
  input: CreateRegenerationCommandRecordInput,
  database: Database = getDatabase(),
): Promise<CreateRegenerationCommandRecordResult> {
  return database.transaction(async (transaction) => {
    const [conversation] = await transaction
      .select({ id: conversations.id, mode: conversations.mode })
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

    if (conversation.mode !== "chat") {
      return { kind: "regeneration_not_allowed" };
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

    const [assistantMessage] = await transaction
      .select({
        id: messages.id,
      })
      .from(messages)
      .where(
        and(
          eq(messages.id, input.assistantMessageId),
          eq(messages.conversationId, conversation.id),
          eq(messages.role, "assistant"),
        ),
      )
      .for("update")
      .limit(1);

    if (!assistantMessage) {
      return { kind: "assistant_message_not_found" };
    }

    const [latestMessage] = await transaction
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, conversation.id))
      .orderBy(desc(messages.sequence))
      .limit(1);

    const [sourceGeneration] = await transaction
      .select({
        userMessageId: generations.userMessageId,
        reasoningEffort: generations.reasoningEffort,
      })
      .from(generations)
      .where(eq(generations.assistantMessageId, assistantMessage.id))
      .limit(1);

    if (
      latestMessage?.id !== assistantMessage.id ||
      !sourceGeneration?.userMessageId ||
      !sourceGeneration.reasoningEffort
    ) {
      return { kind: "regeneration_not_allowed" };
    }

    // 重新生成没有回答版本切换：命令一旦成立，旧回答立即退出历史。
    // 后续 Worker 与普通 Generation 共用同一套完成、取消和失败语义。
    await transaction
      .delete(messages)
      .where(eq(messages.id, assistantMessage.id));

    const [generation] = await transaction
      .insert(generations)
      .values({
        id: input.generationId,
        conversationId: conversation.id,
        userMessageId: sourceGeneration.userMessageId,
        status: "queued",
        reasoningEffort: sourceGeneration.reasoningEffort,
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

    if (!generation || !generation.reasoningEffort) {
      throw new Error("创建 Regeneration 后数据库没有返回记录");
    }

    await transaction
      .update(conversations)
      .set({ updatedAt: input.now })
      .where(eq(conversations.id, conversation.id));

    return {
      kind: "created",
      generation: {
        ...generation,
        reasoningEffort: generation.reasoningEffort,
      },
    };
  });
}
