import type { AssistantMessagePartDto } from "@ai-chat/contracts";
import type { ModelMessage } from "ai";
import type { ChatModelMessage } from "./types";
import {
  KNOWLEDGE_SEARCH_TOOL_NAME,
  toRuntimeHistoryToolName,
} from "./tool-names";

function assistantHistoryLabel(text: string): string {
  return `[上一轮助手输出]\n${text}`;
}

type AssistantContentPart = Extract<
  Extract<ModelMessage, { role: "assistant" }>["content"],
  readonly unknown[]
>[number];

function toToolResultOutput(
  output: Extract<AssistantMessagePartDto, { type: "tool-result" }>["output"],
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
  const knowledgeCalls = new Set(
    message.parts.flatMap((p) =>
      p.type === "tool-call" && p.toolName === KNOWLEDGE_SEARCH_TOOL_NAME
        ? [p.toolCallId]
        : [],
    ),
  );

  function flushAssistant(): void {
    if (content.length === 0) {
      return;
    }

    messages.push({ role: "assistant", content });
    content = [];
  }

  for (const part of message.parts) {
    switch (part.type) {
      case "knowledge-sources":
        // 历史不重复注入原文；本轮需要资料时由工具重新检索。
        break;
      case "reasoning":
        // 思考展示不是确定事实，不回放进下一轮或历史摘要。
        break;
      case "text":
        content.push({ type: "text", text: assistantHistoryLabel(part.text) });
        break;
      case "attachment":
        throw new Error("Chat Model 暂不支持 Assistant Attachment 历史");
      case "tool-call":
        if (knowledgeCalls.has(part.toolCallId)) break;
        toolNames.set(part.toolCallId, toRuntimeHistoryToolName(part.toolName));
        pendingToolCalls.set(
          part.toolCallId,
          toRuntimeHistoryToolName(part.toolName),
        );
        content.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: toRuntimeHistoryToolName(part.toolName),
          input: part.input,
        });
        break;
      case "tool-result": {
        // 成对移除旧知识库调用/结果，防止关库或换库后仍借旧原文作答。
        if (knowledgeCalls.has(part.toolCallId)) break;
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
            message:
              "上一轮工具调用未记录到结果（生成可能已被停止）。执行结果未知，请勿假定调用成功。",
          },
        },
      })),
    });
  }
  return messages;
}

export function toModelMessages(message: ChatModelMessage): ModelMessage[] {
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
