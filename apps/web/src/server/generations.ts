import { randomUUID } from "node:crypto";

import type {
  CreateGenerationRequest,
  CreateGenerationResponse,
  GenerationErrorResponse,
} from "@ai-chat/contracts";
import {
  createGenerationCommandRecord,
  type CreateGenerationCommandRecordResult,
} from "@ai-chat/db";

import { createConversationTitle } from "../lib/conversation-title";

type GenerationServiceStatus = 400 | 404 | 409 | 503;

export interface GenerationQueueProducer {
  enqueue(payload: { generationId: string }): Promise<void>;
}

export class GenerationServiceError extends Error {
  constructor(
    readonly response: GenerationErrorResponse,
    readonly status: GenerationServiceStatus,
  ) {
    super(response.code);
  }
}

type GenerationServiceDependencies = {
  queue: GenerationQueueProducer;
  createGenerationId?: () => string;
  now?: () => Date;
};

function throwForPersistenceResult(
  result: Exclude<
    CreateGenerationCommandRecordResult,
    { kind: "created" } | { kind: "idempotent" }
  >,
): never {
  switch (result.kind) {
    case "conversation_not_found":
      throw new GenerationServiceError(
        { code: "CONVERSATION_NOT_FOUND" },
        404,
      );
    case "message_id_conflict":
      throw new GenerationServiceError({ code: "MESSAGE_ID_CONFLICT" }, 409);
    case "active_generation":
      throw new GenerationServiceError(
        {
          code: "ACTIVE_GENERATION",
          activeGenerationId: result.activeGenerationId,
        },
        409,
      );
    case "attachment_not_found":
      throw new GenerationServiceError(
        {
          code: "ATTACHMENT_NOT_FOUND",
          attachmentId: result.attachmentId,
        },
        404,
      );
    case "attachment_not_ready":
      throw new GenerationServiceError(
        {
          code: "ATTACHMENT_NOT_READY",
          attachmentId: result.attachmentId,
        },
        409,
      );
    case "attachment_in_use":
      throw new GenerationServiceError(
        {
          code: "ATTACHMENT_IN_USE",
          attachmentId: result.attachmentId,
        },
        409,
      );
    case "attachment_mode_mismatch":
      throw new GenerationServiceError(
        {
          code: "ATTACHMENT_MODE_MISMATCH",
          attachmentId: result.attachmentId,
        },
        409,
      );
    case "invalid_request":
      throw new GenerationServiceError({ code: "INVALID_REQUEST" }, 400);
  }
}

export async function createGenerationForOwner(
  ownerId: string,
  input: CreateGenerationRequest,
  dependencies: GenerationServiceDependencies,
): Promise<CreateGenerationResponse> {
  const now = (dependencies.now ?? (() => new Date()))();
  const result = await createGenerationCommandRecord({
    ...input,
    ownerId,
    generationId: (dependencies.createGenerationId ?? randomUUID)(),
    conversationTitle: createConversationTitle(input.parts),
    now,
  });

  if (result.kind !== "created" && result.kind !== "idempotent") {
    throwForPersistenceResult(result);
  }

  if (result.generation.status === "queued") {
    try {
      await dependencies.queue.enqueue({ generationId: result.generation.id });
    } catch {
      throw new GenerationServiceError({ code: "QUEUE_UNAVAILABLE" }, 503);
    }
  }

  return {
    conversationId: result.generation.conversationId,
    generation: {
      id: result.generation.id,
      userMessageId: result.generation.userMessageId,
      status: result.generation.status,
      reasoningEffort: result.generation.reasoningEffort,
      createdAt: result.generation.createdAt.toISOString(),
    },
  };
}
