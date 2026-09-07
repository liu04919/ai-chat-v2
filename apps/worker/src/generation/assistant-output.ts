import {
  knowledgeSourcesPartSchema,
  type AssistantMessagePartDto,
  type KnowledgeSourceDto,
} from "@ai-chat/contracts";
import type { GenerationEventWriter } from "@ai-chat/event-store";
import type { ChatModelStreamPart } from "../llm/chat-model";

type StreamDeltaPart = Extract<
  ChatModelStreamPart,
  { type: "text" | "reasoning" }
>;

type AssistantToolCallPart = Extract<
  AssistantMessagePartDto,
  { type: "tool-call" }
>;
type AssistantToolResultPart = Extract<
  AssistantMessagePartDto,
  { type: "tool-result" }
>;
type JsonValue = AssistantToolCallPart["input"];

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }

  const serialized = JSON.stringify(value, (_key, nestedValue: unknown) => {
    if (nestedValue instanceof Error) {
      return { message: nestedValue.message };
    }

    return nestedValue;
  });

  return serialized === undefined
    ? null
    : (JSON.parse(serialized) as JsonValue);
}

function appendAssistantPart(
  parts: AssistantMessagePartDto[],
  part: AssistantMessagePartDto,
): void {
  if (parts.some((candidate) => candidate.id === part.id)) {
    throw new Error(`Assistant part ${part.id} 在流中重复出现`);
  }

  parts.push(part);
}

function appendAssistantDelta(
  parts: AssistantMessagePartDto[],
  delta: StreamDeltaPart,
): void {
  // 只合并紧邻的同一个片段；不跨过工具或其他文字片段，避免改变回答的顺序。
  const lastPart = parts.at(-1);

  if (lastPart?.id === delta.partId) {
    if (lastPart.type !== delta.type) {
      throw new Error(`Assistant part ${delta.partId} 在流中改变了类型`);
    }

    lastPart.text += delta.delta;
    return;
  }

  if (parts.some((part) => part.id === delta.partId)) {
    throw new Error(`Assistant part ${delta.partId} 在流中非连续地重新出现`);
  }

  parts.push({ id: delta.partId, type: delta.type, text: delta.delta });
}

/**
 * 一次 Generation 一个收集器：累计用于落库的完整回答，并发送浏览器可见的展示事件。
 * 不负责调用模型、更新 Generation 状态或关闭资源，这些生命周期操作留给主流程。
 */
export function createAssistantOutput(input: {
  generationId: string;
  eventWriter: GenerationEventWriter;
}) {
  const { generationId, eventWriter } = input;
  const parts: AssistantMessagePartDto[] = [];
  let finished = false;

  return {
    async appendSources(sources: KnowledgeSourceDto[]) {
      const part = knowledgeSourcesPartSchema.parse({
        id: `knowledge-${generationId}`,
        type: "knowledge-sources",
        sources,
      });
      // 引用由服务器提供，不是模型生成；既随回答保存，也立即发给页面展示。
      appendAssistantPart(parts, part);
      await eventWriter.append({
        type: "knowledge.sources",
        generationId,
        partId: part.id,
        sources: part.sources,
      });
    },

    async consume(
      part: ChatModelStreamPart,
      toPublicToolName: (name: string) => string = (name) => name,
    ) {
      // 先累计，再发送事件：即使发送失败，取消处理仍可取得已经收到的片段。
      // 调用方必须逐片 await，保证 Parts 与展示事件保持相同顺序。
      switch (part.type) {
        case "text":
        case "reasoning":
          appendAssistantDelta(parts, part);
          await eventWriter.append({
            type: part.type === "text" ? "text.delta" : "reasoning.delta",
            generationId,
            partId: part.partId,
            delta: part.delta,
          });
          break;
        case "tool-call": {
          const toolCall: AssistantToolCallPart = {
            id: part.partId,
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: toPublicToolName(part.toolName),
            input: toJsonValue(part.input),
          };
          appendAssistantPart(parts, toolCall);
          // 原始工具参数只留在服务端历史，前端只需要知道调用了哪个工具。
          await eventWriter.append({
            type: "tool.call",
            generationId,
            partId: toolCall.id,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
          });
          break;
        }
        case "tool-result": {
          const toolResult: AssistantToolResultPart = {
            id: part.partId,
            type: "tool-result",
            toolCallId: part.toolCallId,
            output: toJsonValue(part.output),
            isError: part.isError,
          };
          appendAssistantPart(parts, toolResult);
          // 完整结果供后续模型历史使用；展示事件仅暴露完成/失败状态。
          await eventWriter.append({
            type: "tool.result",
            generationId,
            partId: toolResult.id,
            toolCallId: toolResult.toolCallId,
            isError: toolResult.isError,
          });
          break;
        }
        case "finish":
          finished = true;
          break;
      }
    },

    // 取消时允许读取部分回答。返回数组副本，避免调用方改变收集器内的排列。
    getParts() {
      return [...parts];
    },

    getCompletedParts() {
      // 流迭代结束不等于模型正常完成；必须收到适配层的 finish 标记。
      if (!finished) {
        throw new Error("Chat Model 流在 generation.finish 前结束");
      }
      return [...parts];
    },
  };
}
