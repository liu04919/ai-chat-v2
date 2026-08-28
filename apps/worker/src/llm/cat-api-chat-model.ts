import {
  createOpenAI,
  type OpenAILanguageModelResponsesOptions,
  type OpenAIProviderSettings,
} from "@ai-sdk/openai";
import { streamText, type ModelMessage } from "ai";

import type {
  ChatModel,
  ChatModelMessage,
  ChatModelStreamPart,
} from "./chat-model";

export type CatApiChatModelConfig = {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  fetch?: OpenAIProviderSettings["fetch"];
};

function toModelMessage(message: ChatModelMessage): ModelMessage {
  if (message.role === "assistant") {
    return { role: "assistant", content: message.text };
  }

  return {
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
  };
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
        messages: request.messages.map(toModelMessage),
        abortSignal: request.abortSignal,
        providerOptions: {
          openai: {
            forceReasoning: true,
            reasoningEffort: request.reasoningEffort,
            reasoningSummary: "auto",
            store: false,
          } satisfies OpenAILanguageModelResponsesOptions,
        },
      });

      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            yield { type: "text", delta: part.text };
            break;
          case "reasoning-delta":
            yield { type: "reasoning", delta: part.text };
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
