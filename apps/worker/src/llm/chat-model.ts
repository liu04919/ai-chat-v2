import type {
  AssistantMessagePartsDto,
  ReasoningEffortDto,
} from "@ai-chat/contracts";

export type ChatModelUserPart =
  | { type: "text"; text: string }
  | {
      type: "file";
      url: string;
      mediaType: string;
      filename?: string;
    };

export type ChatModelReasoningState = {
  partId: string;
  itemId?: string;
  encryptedContent: string;
};

export type ChatModelProviderState = {
  version: 1;
  provider: "openai-responses";
  reasoning: ChatModelReasoningState[];
};

export type ChatModelMessage =
  | { role: "user"; parts: ChatModelUserPart[] }
  | {
      role: "assistant";
      parts: AssistantMessagePartsDto;
      providerState?: ChatModelProviderState;
    };

export type ChatModelRequest = {
  messages: ChatModelMessage[];
  reasoningEffort: ReasoningEffortDto;
  abortSignal?: AbortSignal;
};

export type ChatModelStreamPart =
  | { type: "text"; partId: string; delta: string }
  | { type: "reasoning"; partId: string; delta: string }
  | {
      type: "finish";
      reason: string;
      providerState: ChatModelProviderState | null;
    };

export interface ChatModel {
  stream(request: ChatModelRequest): AsyncIterable<ChatModelStreamPart>;
}

export function parseChatModelProviderState(
  value: unknown,
): ChatModelProviderState | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("provider" in value) ||
    value.provider !== "openai-responses" ||
    !("reasoning" in value) ||
    !Array.isArray(value.reasoning)
  ) {
    return undefined;
  }

  const reasoning: ChatModelReasoningState[] = [];

  for (const item of value.reasoning) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("partId" in item) ||
      typeof item.partId !== "string" ||
      item.partId.length === 0 ||
      !("encryptedContent" in item) ||
      typeof item.encryptedContent !== "string" ||
      item.encryptedContent.length === 0 ||
      ("itemId" in item &&
        item.itemId !== undefined &&
        typeof item.itemId !== "string")
    ) {
      return undefined;
    }

    reasoning.push({
      partId: item.partId,
      encryptedContent: item.encryptedContent,
      ...("itemId" in item && typeof item.itemId === "string"
        ? { itemId: item.itemId }
        : {}),
    });
  }

  return { version: 1, provider: "openai-responses", reasoning };
}
