import type {
  AssistantMessagePartDto,
  GenerationStatusDto,
} from "@ai-chat/contracts";
import { assistantMessagePartsSchema } from "@ai-chat/contracts";
import { and, eq, max } from "drizzle-orm";

import { getDatabase } from "./client";
import { conversations, generations, messages } from "./schema/index";

type Database = ReturnType<typeof getDatabase>;

export type GenerationCancellationRecord = {
  id: string;
  status: GenerationStatusDto;
  cancelRequestedAt: Date | null;
};

export type RequestGenerationCancellationResult =
  | { kind: "not_found" }
  | { kind: "unchanged"; generation: GenerationCancellationRecord }
  | { kind: "queued_cancelled"; generation: GenerationCancellationRecord }
  | { kind: "running_requested"; generation: GenerationCancellationRecord };

function assertNonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} 不能为空`);
  }

  return value;
}

export async function requestGenerationCancellationForOwner(
  input: { ownerId: string; generationId: string; now: Date },
  database: Database = getDatabase(),
): Promise<RequestGenerationCancellationResult> {
  assertNonEmpty(input.ownerId, "ownerId");
  assertNonEmpty(input.generationId, "generationId");

  return database.transaction(async (transaction) => {
    const [generation] = await transaction
      .select({
        id: generations.id,
        status: generations.status,
        cancelRequestedAt: generations.cancelRequestedAt,
      })
      .from(generations)
      .innerJoin(
        conversations,
        eq(conversations.id, generations.conversationId),
      )
      .where(
        and(
          eq(generations.id, input.generationId),
          eq(conversations.ownerId, input.ownerId),
        ),
      )
      .for("update")
      .limit(1);

    if (!generation) {
      return { kind: "not_found" };
    }

    if (generation.status === "queued") {
      const [cancelled] = await transaction
        .update(generations)
        .set({
          status: "cancelled",
          cancelRequestedAt: input.now,
          finishedAt: input.now,
          errorCode: null,
        })
        .where(eq(generations.id, generation.id))
        .returning({
          id: generations.id,
          status: generations.status,
          cancelRequestedAt: generations.cancelRequestedAt,
        });

      if (!cancelled) {
        throw new Error("queued Generation 取消后未返回记录");
      }

      return { kind: "queued_cancelled", generation: cancelled };
    }

    if (generation.status === "running") {
      const requestedAt = generation.cancelRequestedAt ?? input.now;

      if (!generation.cancelRequestedAt) {
        await transaction
          .update(generations)
          .set({ cancelRequestedAt: requestedAt })
          .where(eq(generations.id, generation.id));
      }

      return {
        kind: "running_requested",
        generation: {
          ...generation,
          cancelRequestedAt: requestedAt,
        },
      };
    }

    return { kind: "unchanged", generation };
  });
}

export async function isGenerationCancellationRequested(
  generationId: string,
  database: Database = getDatabase(),
): Promise<boolean> {
  assertNonEmpty(generationId, "generationId");

  const [generation] = await database
    .select({ cancelRequestedAt: generations.cancelRequestedAt })
    .from(generations)
    .where(
      and(
        eq(generations.id, generationId),
        eq(generations.status, "running"),
      ),
    )
    .limit(1);

  return Boolean(generation?.cancelRequestedAt);
}

export async function cancelGenerationExecution(
  input: {
    generationId: string;
    assistantMessageId: string | null;
    assistantParts: AssistantMessagePartDto[];
    now: Date;
  },
  database: Database = getDatabase(),
): Promise<boolean> {
  assertNonEmpty(input.generationId, "generationId");

  if ((input.assistantMessageId === null) !== (input.assistantParts.length === 0)) {
    throw new TypeError(
      "取消时 Assistant Message ID 与可见 parts 必须同时存在或同时为空",
    );
  }

  const assistantParts =
    input.assistantParts.length === 0
      ? []
      : assistantMessagePartsSchema.parse(input.assistantParts);

  if (input.assistantMessageId) {
    assertNonEmpty(input.assistantMessageId, "assistantMessageId");
  }

  return database.transaction(async (transaction) => {
    const [generation] = await transaction
      .select({
        conversationId: generations.conversationId,
        status: generations.status,
        cancelRequestedAt: generations.cancelRequestedAt,
        replacesAssistantMessageId: generations.replacesAssistantMessageId,
      })
      .from(generations)
      .where(eq(generations.id, input.generationId))
      .for("update")
      .limit(1);

    if (
      !generation ||
      generation.status !== "running" ||
      !generation.cancelRequestedAt
    ) {
      return false;
    }

    const shouldPersistPartial =
      !generation.replacesAssistantMessageId &&
      input.assistantMessageId !== null &&
      assistantParts.length > 0;

    if (shouldPersistPartial && input.assistantMessageId) {
      const [sequenceRow] = await transaction
        .select({ sequence: max(messages.sequence) })
        .from(messages)
        .where(eq(messages.conversationId, generation.conversationId));
      const nextSequence = Number(sequenceRow?.sequence ?? -1) + 1;

      await transaction.insert(messages).values({
        id: input.assistantMessageId,
        conversationId: generation.conversationId,
        role: "assistant",
        parts: assistantParts,
        sequence: nextSequence,
        createdAt: input.now,
      });
    }

    await transaction
      .update(generations)
      .set({
        status: "cancelled",
        assistantMessageId: shouldPersistPartial
          ? input.assistantMessageId
          : null,
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
