import type {
  CancelGenerationErrorResponse,
  CancelGenerationResponse,
} from "@ai-chat/contracts";
import { requestGenerationCancellationForOwner } from "@ai-chat/db";
import type {
  GenerationCancellationPublisher,
  GenerationEventWriter,
} from "@ai-chat/event-store";

type GenerationCancellationServiceStatus = 404 | 503;

export class GenerationCancellationServiceError extends Error {
  constructor(
    readonly response: CancelGenerationErrorResponse,
    readonly status: GenerationCancellationServiceStatus,
  ) {
    super(response.code);
  }
}

export type GenerationCancellationDependencies = {
  cancellationPublisher: GenerationCancellationPublisher;
  eventWriter: GenerationEventWriter;
  now?: () => Date;
};

export async function cancelGenerationForOwner(
  ownerId: string,
  generationId: string,
  dependencies: GenerationCancellationDependencies,
): Promise<CancelGenerationResponse> {
  const result = await requestGenerationCancellationForOwner({
    ownerId,
    generationId,
    now: (dependencies.now ?? (() => new Date()))(),
  });

  if (result.kind === "not_found") {
    throw new GenerationCancellationServiceError(
      { code: "GENERATION_NOT_FOUND" },
      404,
    );
  }

  try {
    if (result.kind === "running_requested") {
      await dependencies.cancellationPublisher.publish(generationId);
    } else if (
      result.kind === "queued_cancelled" ||
      (result.kind === "unchanged" &&
        result.generation.status === "cancelled")
    ) {
      await dependencies.eventWriter.append({
        type: "generation.cancelled",
        generationId,
      });
    }
  } catch {
    throw new GenerationCancellationServiceError(
      { code: "CANCEL_SIGNAL_UNAVAILABLE" },
      503,
    );
  }

  return {
    generation: {
      id: result.generation.id,
      status: result.generation.status,
      cancelRequestedAt:
        result.generation.cancelRequestedAt?.toISOString() ?? null,
    },
  };
}
