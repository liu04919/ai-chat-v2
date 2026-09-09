import type { ReasoningEffortDto } from "@ai-chat/contracts";
import type { ChatModelMessage } from "@ai-chat/model-context";
export type { ChatModelMessage, ChatModelUserPart } from "@ai-chat/model-context";
import type { ToolSet } from "ai";

export type ChatModelRequest = {
  /** Worker 已计算的初始总输入；模型工具循环只追加本轮新输出的成本。 */
  contextInputTokens?: number;
  /** 派生历史背景，不作为 system instructions；原消息仍完整保存在数据库。 */
  historySummary?: string | null;
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
