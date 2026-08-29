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

export type ChatModelMessage =
  | { role: "user"; parts: ChatModelUserPart[] }
  | {
      role: "assistant";
      parts: AssistantMessagePartsDto;
    };

export type ChatModelRequest = {
  messages: ChatModelMessage[];
  reasoningEffort: ReasoningEffortDto;
  abortSignal?: AbortSignal;
};

export type ChatModelStreamPart =
  | { type: "text"; partId: string; delta: string }
  | { type: "reasoning"; partId: string; delta: string }
  | { type: "finish"; reason: string };

export interface ChatModel {
  stream(request: ChatModelRequest): AsyncIterable<ChatModelStreamPart>;
}
