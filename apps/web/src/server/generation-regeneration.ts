import { randomUUID } from "node:crypto";

import type {
  RegenerateGenerationRequest,
  RegenerateGenerationResponse,
  RegenerationErrorResponse,
} from "@ai-chat/contracts";
import {
  createRegenerationCommandRecord,
  type CreateRegenerationCommandRecordResult,
} from "@ai-chat/db";

import type { GenerationQueueProducer } from "./generations";

type RegenerationServiceStatus = 400 | 404 | 409 | 503;

export class RegenerationServiceError extends Error {
  constructor(
    readonly response: RegenerationErrorResponse,
    readonly status: RegenerationServiceStatus,
  ) {
    super(response.code);
  }
}

type RegenerationServiceDependencies = {
  queue: GenerationQueueProducer;
  createGenerationId?: () => string;
  now?: () => Date;
};

function throwForPersistenceResult(
  result: Exclude<CreateRegenerationCommandRecordResult, { kind: "created" }>,
): never {
  switch (result.kind) {
    case "conversation_not_found":
      throw new RegenerationServiceError(
        { code: "CONVERSATION_NOT_FOUND" },
        404,
      );
    case "assistant_message_not_found":
      throw new RegenerationServiceError(
        { code: "ASSISTANT_MESSAGE_NOT_FOUND" },
        404,
      );
    case "regeneration_not_allowed":
      throw new RegenerationServiceError(
        { code: "REGENERATION_NOT_ALLOWED" },
        409,
      );
    case "active_generation":
      throw new RegenerationServiceError(
        {
          code: "ACTIVE_GENERATION",
          activeGenerationId: result.activeGenerationId,
        },
        409,
      );
  }
}

export async function regenerateGenerationForOwner(
  ownerId: string,
  input: RegenerateGenerationRequest,
  dependencies: RegenerationServiceDependencies,
): Promise<RegenerateGenerationResponse> {
  const result = await createRegenerationCommandRecord({
    ...input,
    ownerId,
    generationId: (dependencies.createGenerationId ?? randomUUID)(),
    now: (dependencies.now ?? (() => new Date()))(),
  });

  if (result.kind !== "created") {
    throwForPersistenceResult(result);
  }

  try {
    await dependencies.queue.enqueue({ generationId: result.generation.id });
  } catch {
    throw new RegenerationServiceError({ code: "QUEUE_UNAVAILABLE" }, 503);
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
