import {
  createOpenAI,
  type OpenAILanguageModelResponsesOptions,
  type OpenAIProviderSettings,
} from "@ai-sdk/openai";
import type { AssistantMessagePartDto } from "@ai-chat/contracts";
import {
  isStepCount,
  streamText,
  type ModelMessage,
} from "ai";

import type {
  ChatModel,
  ChatModelMessage,
  ChatModelStreamPart,
} from "./chat-model";
import { toRuntimeHistoryToolName } from "../tools/tool-names";

export type CatApiChatModelConfig = {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  fetch?: OpenAIProviderSettings["fetch"];
};

function reasoningHistoryLabel(text: string): string {
  return `[上一轮展示给用户的思考摘要]\n${text}`;
}

function assistantHistoryLabel(text: string): string {
  return `[上一轮助手输出]\n${text}`;
}

type AssistantContentPart = Extract<
  Extract<ModelMessage, { role: "assistant" }>["content"],
  readonly unknown[]
>[number];

function toToolResultOutput(
  output: Extract<
    AssistantMessagePartDto,
    { type: "tool-result" }
  >["output"],
  isError: boolean,
) {
  return isError
    ? ({ type: "error-json", value: output } as const)
    : ({ type: "json", value: output } as const);
}

function toAssistantModelMessages(
  message: Extract<ChatModelMessage, { role: "assistant" }>,
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  let content: AssistantContentPart[] = [];
  const toolNames = new Map<string, string>();
  const pendingToolCalls = new Map<string, string>();

  function flushAssistant(): void {
    if (content.length === 0) {
      return;
    }

    messages.push({ role: "assistant", content });
    content = [];
  }

  for (const part of message.parts) {
    switch (part.type) {
      case "reasoning":
        content.push({ type: "text", text: reasoningHistoryLabel(part.text) });
        break;
      case "text":
        content.push({ type: "text", text: assistantHistoryLabel(part.text) });
        break;
      case "attachment":
        throw new Error("Chat Model 暂不支持 Assistant Attachment 历史");
      case "tool-call":
        toolNames.set(
          part.toolCallId,
          toRuntimeHistoryToolName(part.toolName),
        );
        pendingToolCalls.set(part.toolCallId, toRuntimeHistoryToolName(part.toolName));
        content.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: toRuntimeHistoryToolName(part.toolName),
          input: part.input,
        });
        break;
      case "tool-result": {
        const toolName = toolNames.get(part.toolCallId);
        if (!toolName) {
          throw new Error(
            `Assistant Tool Result ${part.toolCallId} 缺少对应的 Tool Call`,
          );
        }

        flushAssistant();
        pendingToolCalls.delete(part.toolCallId);
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: part.toolCallId,
              toolName,
              output: toToolResultOutput(part.output, part.isError),
            },
          ],
        });
        break;
      }
    }
  }

  flushAssistant();
  // 停止生成可能只保存了调用。仅修复发送给模型的历史，不改落库内容，
  // 也不推断工具是否已产生副作用，更不能自动重试这个调用。
  if (pendingToolCalls.size > 0) {
    messages.push({
      role: "tool",
      content: [...pendingToolCalls].map(([toolCallId, toolName]) => ({
        type: "tool-result" as const,
        toolCallId,
        toolName,
        output: {
          type: "error-json" as const,
          value: {
            code: "TOOL_RESULT_UNAVAILABLE",
            message: "上一轮工具调用未记录到结果（生成可能已被停止）。执行结果未知，请勿假定调用成功。",
          },
        },
      })),
    });
  }
  return messages;
}

function toModelMessages(message: ChatModelMessage): ModelMessage[] {
  if (message.role === "assistant") {
    return toAssistantModelMessages(message);
  }

  return [
    {
      role: "user",
      content: message.parts.map((part) => {
        if (part.type === "text") {
          return part;
        }

        return {
          type: "file" as const,
          data: new URL(part.url),
          mediaType: part.mediaType,
          ...(part.filename ? { filename: part.filename } : {}),
        };
      }),
    },
  ];
}

function toError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error
    ? error
    : new Error(fallbackMessage, { cause: error });
}

export function createCatApiChatModel(
  config: CatApiChatModelConfig,
): ChatModel {
  const provider = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    fetch: config.fetch,
  });
  const model = provider.responses(config.modelId);

  return {
    async *stream(request): AsyncIterable<ChatModelStreamPart> {
      const result = streamText({
        model,
        maxRetries: 0,
        messages: request.messages.flatMap(toModelMessages),
        abortSignal: request.abortSignal,
        ...(request.tools
          ? { tools: request.tools, stopWhen: isStepCount(8) }
          : {}),
        providerOptions: {
          openai: {
            forceReasoning: true,
            reasoningEffort: request.reasoningEffort,
            reasoningSummary: "auto",
            store: false,
          } satisfies OpenAILanguageModelResponsesOptions,
        },
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
            yield { type: "finish", reason: part.finishReason };
            break;
          case "error":
            throw toError(part.error, "CatAPI 流式响应失败");
          case "abort":
            throw new Error(part.reason ?? "CatAPI 流式响应已取消");
          default:
            break;
        }
      }
    },
  };
}
