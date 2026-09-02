import type {
  AssistantMessagePartsDto,
  ReasoningEffortDto,
} from "@ai-chat/contracts";
import type { ToolSet } from "ai";

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
  tools?: ToolSet;
  abortSignal?: AbortSignal;
};

export type ChatModelStreamPart =
  | { type: "text"; partId: string; delta: string }
  | { type: "reasoning"; partId: string; delta: string }
  | {
      type: "tool-call";
      partId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: "tool-result";
      partId: string;
      toolCallId: string;
      output: unknown;
      isError: boolean;
    }
  | { type: "finish"; reason: string };

export interface ChatModel {
  stream(request: ChatModelRequest): AsyncIterable<ChatModelStreamPart>;
}
