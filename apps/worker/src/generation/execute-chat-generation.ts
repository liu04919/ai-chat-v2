import { randomUUID } from "node:crypto";

import type { AssistantMessagePartDto } from "@ai-chat/contracts";
import {
  prepareChatKnowledge,
  emptyKnowledgeResponse,
  type ChatKnowledgeRetriever,
} from "../knowledge/chat-knowledge";
import type {
  GenerationCancellationSubscriber,
  GenerationEventWriter,
} from "@ai-chat/event-store";
import type { ObjectStorage } from "@ai-chat/storage";
import {
  type ClaimedGenerationExecution,
  cancelGenerationExecution,
  completeGenerationExecution,
  failGenerationExecution,
  isGenerationCancellationRequested,
} from "@ai-chat/db";

import type { ChatModel, ChatModelStreamPart } from "../llm/chat-model";
import type {
  GenerationToolResolver,
  ResolvedGenerationTools,
} from "../tools/generation-tool-resolver";
import { createAssistantOutput } from "./assistant-output";
import { buildChatModelRequest } from "./chat-context-builder";
import {
  coalesceChatModelStream,
  type DeltaCoalescingOptions,
} from "./delta-coalescer";

const CHAT_GENERATION_FAILED = "CHAT_GENERATION_FAILED";

export type ExecuteChatGenerationDependencies = {
  chatModel: ChatModel;
  cancellationSubscriber: GenerationCancellationSubscriber;
  eventWriter: GenerationEventWriter;
  objectStorage: Pick<ObjectStorage, "createDownloadUrl">;
  toolResolver?: GenerationToolResolver;
  knowledgeRetriever?: ChatKnowledgeRetriever;
  coalescing?: DeltaCoalescingOptions;
  createAssistantMessageId?: () => string;
  now?: () => Date;
};

export type ExecuteChatGenerationResult =
  | { kind: "completed"; assistantMessageId: string }
  | { kind: "cancelled"; assistantMessageId: string | null };

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Chat Generation 执行失败", { cause: error });
}

async function recordFailure(
  execution: ClaimedGenerationExecution,
  error: Error,
  assistantParts: AssistantMessagePartDto[],
  dependencies: ExecuteChatGenerationDependencies,
): Promise<ExecuteChatGenerationResult> {
  const generationId = execution.id;
  try {
    const failed = await failGenerationExecution({
      generationId,
      errorCode: CHAT_GENERATION_FAILED,
      now: (dependencies.now ?? (() => new Date()))(),
    });

    if (failed) {
      await dependencies.eventWriter.append({
        type: "generation.failed",
        generationId,
      });
    } else if (await isGenerationCancellationRequested(generationId)) {
      // 用户停止可能先于失败更新到达数据库，不能把这次取消覆盖成生成失败。
      return recordCancellation(execution, assistantParts, dependencies);
    }
  } catch (recordingError) {
    throw new AggregateError(
      [error, recordingError],
      "Chat Generation 失败，且记录失败状态时再次出错",
    );
  }

  throw error;
}

async function recordCancellation(
  execution: ClaimedGenerationExecution,
  assistantParts: AssistantMessagePartDto[],
  dependencies: ExecuteChatGenerationDependencies,
): Promise<Extract<ExecuteChatGenerationResult, { kind: "cancelled" }>> {
  const generationId = execution.id;
  // 只有引用、尚无任何模型输出时，不制造一条空的助手消息。
  const visibleParts = assistantParts.some(
    (p) => p.type !== "knowledge-sources",
  )
    ? assistantParts
    : [];
  const assistantMessageId =
    visibleParts.length > 0
      ? (dependencies.createAssistantMessageId ?? randomUUID)()
      : null;
  const cancelled = await cancelGenerationExecution({
    generationId,
    assistantMessageId,
    assistantParts: visibleParts,
    now: (dependencies.now ?? (() => new Date()))(),
  });

  if (!cancelled) {
    throw new Error("Generation 已不再处于待取消的 running 状态");
  }

  await dependencies.eventWriter.append({
    type: "generation.cancelled",
    generationId,
  });

  return { kind: "cancelled", assistantMessageId };
}

// 主流程管理本轮生命周期；知识库准备与回答投影分别封装，不在这里展开协议细节。
export async function executeChatGeneration(
  execution: ClaimedGenerationExecution,
  dependencies: ExecuteChatGenerationDependencies,
): Promise<ExecuteChatGenerationResult> {
  const generationId = execution.id;
  const abortController = new AbortController();
  const output = createAssistantOutput({
    generationId,
    eventWriter: dependencies.eventWriter,
  });
  let resolvedTools: ResolvedGenerationTools | undefined;
  let unsubscribe: () => Promise<void>;

  try {
    unsubscribe = await dependencies.cancellationSubscriber.subscribe(
      generationId,
      () => abortController.abort("用户已请求停止生成"),
    );
  } catch (error) {
    return recordFailure(
      execution,
      asError(error),
      output.getParts(),
      dependencies,
    );
  }

  try {
    // 先订阅再查持久化标记，覆盖领取任务到建立订阅之间的取消窗口。
    if (await isGenerationCancellationRequested(generationId)) {
      abortController.abort("用户已请求停止生成");
    }

    abortController.signal.throwIfAborted();
    await dependencies.eventWriter.append({
      type: "generation.started",
      generationId,
    });

    // 准备阶段只组装模型请求；引用保存与展示交给同一个回答收集器。
    const request = await buildChatModelRequest(
      execution,
      dependencies.objectStorage,
    );
    const knowledge = await prepareChatKnowledge(
      execution,
      request,
      abortController.signal,
      dependencies.knowledgeRetriever,
    );
    if (knowledge.kind !== "disabled") {
      await output.appendSources(knowledge.sources);
    }
    abortController.signal.throwIfAborted();

    let stream: AsyncIterable<ChatModelStreamPart>;
    if (knowledge.kind === "empty") {
      // 空库直接生成固定提示，不准备工具、不调用模型；仍走下方统一收尾。
      stream = emptyKnowledgeResponse(generationId);
    } else {
      if (dependencies.toolResolver) {
        resolvedTools = await dependencies.toolResolver.resolve(execution.tools);
        request.tools = resolvedTools.tools;
      } else if (
        execution.tools.webSearch || execution.tools.mcpToolIds.length > 0
      ) {
        throw new Error("Generation 选择了 Tool，但 Worker 未配置 Tool Resolver");
      }
      request.abortSignal = abortController.signal;
      stream = dependencies.chatModel.stream(request);
    }

    for await (const part of coalesceChatModelStream(
      stream,
      dependencies.coalescing,
    )) {
      await output.consume(
        part,
        (name) => resolvedTools?.toPublicToolName(name) ?? name,
      );
    }

    const assistantParts = output.getCompletedParts();
    // 数据库先确认 running → completed，再发布完成事件，避免页面读到未落库的回答。
    const assistantMessageId = await completeGenerationExecution({
      generationId,
      assistantMessageId: (
        dependencies.createAssistantMessageId ?? randomUUID
      )(),
      assistantParts,
      now: (dependencies.now ?? (() => new Date()))(),
    });

    if (!assistantMessageId) {
      if (await isGenerationCancellationRequested(generationId)) {
        return recordCancellation(execution, assistantParts, dependencies);
      }

      throw new Error("Generation 已不再处于 running，无法完成落库");
    }

    await dependencies.eventWriter.append({
      type: "generation.completed",
      generationId,
    });

    return { kind: "completed", assistantMessageId };
  } catch (error) {
    // 数据库取消标记决定终态；不能仅凭网络 AbortError 判断是用户主动停止。
    if (await isGenerationCancellationRequested(generationId)) {
      return recordCancellation(execution, output.getParts(), dependencies);
    }

    return recordFailure(
      execution,
      asError(error),
      output.getParts(),
      dependencies,
    );
  } finally {
    // 无论检索、工具还是模型在哪一步失败，都释放本轮持有的订阅和 MCP 连接。
    await Promise.all([unsubscribe(), resolvedTools?.close()]);
  }
}
