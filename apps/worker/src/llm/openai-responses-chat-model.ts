import {
  createOpenAI,
  type OpenAILanguageModelResponsesOptions,
  type OpenAIProviderSettings,
} from "@ai-sdk/openai";
import { isStepCount, ToolLoopAgent } from "ai";

import type { ChatModel, ChatModelStreamPart } from "./chat-model";
import { toModelMessages } from "@ai-chat/model-context";
import { summaryMessage } from "../context/history-projection";
import {
  assertInputBudget,
  CHAT_CONTEXT_POLICY,
  countModelMessages,
  countRequestOverhead,
} from "../context/token-budget";

export type OpenAIResponsesChatModelConfig = {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  fetch?: OpenAIProviderSettings["fetch"];
};

function toError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error
    ? error
    : new Error(fallbackMessage, { cause: error });
}

export function createOpenAIResponsesChatModel(
  config: OpenAIResponsesChatModelConfig,
): ChatModel {
  const provider = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    fetch: config.fetch,
  });
  const model = provider.responses(config.modelId);

  return {
    async *stream(request): AsyncIterable<ChatModelStreamPart> {
      const initialMessages = [
        ...(request.historySummary
          ? [summaryMessage(request.historySummary)]
          : []),
        ...request.messages.flatMap(toModelMessages),
      ];
      const initialTokens =
        request.contextInputTokens ??
        (await countRequestOverhead(request.instructions, request.tools)) +
          countModelMessages(initialMessages);
      const agent = new ToolLoopAgent({
        model,
        instructions: request.instructions,
        maxRetries: 0,
        maxOutputTokens: CHAT_CONTEXT_POLICY.maxOutputTokens,
        tools: request.tools,
        stopWhen: isStepCount(request.tools ? 8 : 1),
        prepareStep: ({ stepNumber, responseMessages }) => {
          request.abortSignal?.throwIfAborted();
          // 历史已在准备阶段计数；只计算本轮新增的助手/工具消息，避免反复编码长历史。
          assertInputBudget(
            initialTokens + countModelMessages(responseMessages),
          );
          return {
            activeTools: stepNumber >= 7 ? [] : request.activeTools?.(),
            // 给最后一步留出回答机会，不能在工具刚完成时直接截断整个循环。
            ...(stepNumber >= 7 ? { toolChoice: "none" as const } : {}),
          };
        },
        providerOptions: {
          openai: {
            forceReasoning: true,
            reasoningEffort: request.reasoningEffort,
            reasoningSummary: "auto",
            store: false,
          } satisfies OpenAILanguageModelResponsesOptions,
        },
      });
      const result = await agent.stream({
        messages: initialMessages,
        abortSignal: request.abortSignal,
      });

      for await (const part of result.stream) {
        switch (part.type) {
          case "text-delta":
            yield { type: "text", partId: part.id, delta: part.text };
            break;
          case "reasoning-start":
          case "reasoning-end":
            break;
          case "reasoning-delta":
            yield { type: "reasoning", partId: part.id, delta: part.text };
            break;
          case "tool-call":
            yield {
              type: "tool-call",
              partId: `tool-call:${part.toolCallId}`,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
            };
            break;
          case "tool-result":
            if (!part.preliminary) {
              yield {
                type: "tool-result",
                partId: `tool-result:${part.toolCallId}`,
                toolCallId: part.toolCallId,
                output: part.output,
                isError: false,
              };
            }
            break;
          case "tool-error":
            yield {
              type: "tool-result",
              partId: `tool-result:${part.toolCallId}`,
              toolCallId: part.toolCallId,
              output: {
                message:
                  part.error instanceof Error
                    ? part.error.message
                    : "Tool 执行失败",
              },
              isError: true,
            };
            break;
          case "finish":
            if (part.finishReason === "tool-calls") {
              throw new Error(
                "MODEL_TOOL_STEP_LIMIT: 工具循环结束，但模型尚未完成回答",
              );
            }
            yield { type: "finish", reason: part.finishReason };
            break;
          case "error":
            throw toError(part.error, "OpenAI Responses 流式响应失败");
          case "abort":
            throw new Error(part.reason ?? "OpenAI Responses 流式响应已取消");
          default:
            break;
        }
      }
    },
  };
}
