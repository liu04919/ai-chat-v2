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
  hasStarted: boolean;
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
    hasStarted: false,
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
      hasStarted: true,
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

  return { ...projection, status: "running", hasStarted: true, parts };
}

function appendToolEvent(
  projection: GenerationProjection,
  event: Extract<
    GenerationEventDto,
    { type: "tool.call" | "tool.result" }
  >,
): GenerationProjection {
  if (projection.parts.some((part) => part.id === event.partId)) {
    return { ...projection, status: "connection-error" };
  }

  if (
    event.type === "tool.result" &&
    !projection.parts.some(
      (part) =>
        part.type === "tool-call" && part.toolCallId === event.toolCallId,
    )
  ) {
    return { ...projection, status: "connection-error" };
  }

  const part: AssistantMessagePartDto =
    event.type === "tool.call"
      ? {
          id: event.partId,
          type: "tool-call",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
        }
      : {
          id: event.partId,
          type: "tool-result",
          toolCallId: event.toolCallId,
          output: event.output,
          isError: event.isError,
        };

  return {
    ...projection,
    status: "running",
    hasStarted: true,
    parts: [...projection.parts, part],
  };
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
        return { ...current, status: "running", hasStarted: true };
      case "reasoning.delta":
      case "text.delta":
        return appendDelta(current, event);
      case "tool.call":
      case "tool.result":
        return appendToolEvent(current, event);
      case "generation.completed":
        return { ...current, status: "completed" };
      case "generation.failed":
        return { ...current, status: "failed" };
      case "generation.cancelled":
        return { ...current, status: "cancelled" };
    }
  }, projection);
}
