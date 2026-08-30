import type {
  AssistantMessagePartDto,
  GenerationEventDto,
} from "@ai-chat/contracts";

export type GenerationProjectionStatus =
  | "connecting"
  | "running"
  | "reconnecting"
  | "completed"
  | "failed"
  | "cancelled"
  | "connection-error";

export type GenerationProjection = {
  conversationId: string;
  generationId: string;
  status: GenerationProjectionStatus;
  parts: AssistantMessagePartDto[];
};

export function createGenerationProjection(
  conversationId: string,
  generationId: string,
): GenerationProjection {
  return {
    conversationId,
    generationId,
    status: "connecting",
    parts: [],
  };
}

function appendDelta(
  projection: GenerationProjection,
  event: Extract<
    GenerationEventDto,
    { type: "reasoning.delta" | "text.delta" }
  >,
): GenerationProjection {
  const partType = event.type === "reasoning.delta" ? "reasoning" : "text";
  const partIndex = projection.parts.findIndex(
    (part) => part.id === event.partId,
  );

  if (partIndex === -1) {
    return {
      ...projection,
      status: "running",
      parts: [
        ...projection.parts,
        { id: event.partId, type: partType, text: event.delta },
      ],
    };
  }

  const currentPart = projection.parts[partIndex];

  if (
    !currentPart ||
    (currentPart.type !== "reasoning" && currentPart.type !== "text") ||
    currentPart.type !== partType
  ) {
    return { ...projection, status: "connection-error" };
  }

  const parts = [...projection.parts];
  parts[partIndex] = {
    ...currentPart,
    text: currentPart.text + event.delta,
  };

  return { ...projection, status: "running", parts };
}

export function reduceGenerationEvents(
  projection: GenerationProjection,
  events: readonly GenerationEventDto[],
): GenerationProjection {
  return events.reduce((current, event) => {
    if (
      current.status === "completed" ||
      current.status === "failed" ||
      current.status === "cancelled" ||
      current.status === "connection-error"
    ) {
      return current;
    }

    if (event.generationId !== current.generationId) {
      return { ...current, status: "connection-error" };
    }

    switch (event.type) {
      case "generation.started":
        return { ...current, status: "running" };
      case "reasoning.delta":
      case "text.delta":
        return appendDelta(current, event);
      case "generation.completed":
        return { ...current, status: "completed" };
      case "generation.failed":
        return { ...current, status: "failed" };
      case "generation.cancelled":
        return { ...current, status: "cancelled" };
    }
  }, projection);
}
