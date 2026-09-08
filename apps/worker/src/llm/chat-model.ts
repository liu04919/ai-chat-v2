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
  instructions?: string;
  messages: ChatModelMessage[];
  reasoningEffort: ReasoningEffortDto;
  tools?: ToolSet;
  /** 每个模型步骤重新计算可用工具，例如检索次数耗尽后移除知识库工具。 */
  activeTools?: () => string[];
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
