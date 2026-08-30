import { randomUUID } from "node:crypto";

import type { AssistantMessagePartDto } from "@ai-chat/contracts";
import type {
  GenerationCancellationSubscriber,
  GenerationEventWriter,
} from "@ai-chat/event-store";
import type { ObjectStorage } from "@ai-chat/storage";
import {
  claimGenerationExecution,
  cancelGenerationExecution,
  completeGenerationExecution,
  failGenerationExecution,
  isGenerationCancellationRequested,
} from "@ai-chat/db";

import type { ChatModel, ChatModelStreamPart } from "../llm/chat-model";
import { buildChatModelRequest } from "./context-builder";
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
  coalescing?: DeltaCoalescingOptions;
  createAssistantMessageId?: () => string;
  now?: () => Date;
};

export type ExecuteChatGenerationResult =
  | { kind: "completed"; assistantMessageId: string }
  | { kind: "cancelled"; assistantMessageId: string | null }
  | { kind: "skipped" };

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Chat Generation 执行失败", { cause: error });
}

type StreamDeltaPart = Extract<
  ChatModelStreamPart,
  { type: "text" | "reasoning" }
>;

function appendAssistantDelta(
  parts: AssistantMessagePartDto[],
  delta: StreamDeltaPart,
): void {
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

async function recordFailure(
  generationId: string,
  error: Error,
  assistantParts: AssistantMessagePartDto[],
  dependencies: ExecuteChatGenerationDependencies,
): Promise<ExecuteChatGenerationResult> {
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
      return recordCancellation(
        generationId,
        assistantParts,
        dependencies,
      );
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
  generationId: string,
  assistantParts: AssistantMessagePartDto[],
  dependencies: ExecuteChatGenerationDependencies,
): Promise<Extract<ExecuteChatGenerationResult, { kind: "cancelled" }>> {
  const assistantMessageId =
    assistantParts.length > 0
      ? (dependencies.createAssistantMessageId ?? randomUUID)()
      : null;
  const cancelled = await cancelGenerationExecution({
    generationId,
    assistantMessageId,
    assistantParts,
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

export async function executeChatGeneration(
  generationId: string,
  dependencies: ExecuteChatGenerationDependencies,
): Promise<ExecuteChatGenerationResult> {
  const claim = await claimGenerationExecution(
    generationId,
    (dependencies.now ?? (() => new Date()))(),
  );

  if (claim.kind === "not_queued") {
    return { kind: "skipped" };
  }

  const abortController = new AbortController();
  const assistantParts: AssistantMessagePartDto[] = [];
  let unsubscribe: () => Promise<void>;

  try {
    unsubscribe = await dependencies.cancellationSubscriber.subscribe(
      generationId,
      () => abortController.abort("用户已请求停止生成"),
    );
  } catch (error) {
    return recordFailure(
      generationId,
      asError(error),
      assistantParts,
      dependencies,
    );
  }

  try {
    if (await isGenerationCancellationRequested(generationId)) {
      abortController.abort("用户已请求停止生成");
    }

    abortController.signal.throwIfAborted();
    await dependencies.eventWriter.append({
      type: "generation.started",
      generationId,
    });

    const request = await buildChatModelRequest(
      claim.execution,
      dependencies.objectStorage,
    );
    abortController.signal.throwIfAborted();
    request.abortSignal = abortController.signal;
    let finished = false;

    for await (const part of coalesceChatModelStream(
      dependencies.chatModel.stream(request),
      dependencies.coalescing,
    )) {
      switch (part.type) {
        case "text":
          appendAssistantDelta(assistantParts, part);
          await dependencies.eventWriter.append({
            type: "text.delta",
            generationId,
            partId: part.partId,
            delta: part.delta,
          });
          break;
        case "reasoning":
          appendAssistantDelta(assistantParts, part);
          await dependencies.eventWriter.append({
            type: "reasoning.delta",
            generationId,
            partId: part.partId,
            delta: part.delta,
          });
          break;
        case "finish":
          finished = true;
          break;
      }
    }

    if (!finished) {
      throw new Error("Chat Model 流在 generation.finish 前结束");
    }

    const assistantMessageId = (
      dependencies.createAssistantMessageId ?? randomUUID
    )();
    const completed = await completeGenerationExecution({
      generationId,
      assistantMessageId,
      assistantParts,
      now: (dependencies.now ?? (() => new Date()))(),
    });

    if (!completed) {
      if (await isGenerationCancellationRequested(generationId)) {
        return recordCancellation(
          generationId,
          assistantParts,
          dependencies,
        );
      }

      throw new Error("Generation 已不再处于 running，无法完成落库");
    }

    await dependencies.eventWriter.append({
      type: "generation.completed",
      generationId,
    });

    return { kind: "completed", assistantMessageId };
  } catch (error) {
    if (await isGenerationCancellationRequested(generationId)) {
      return recordCancellation(generationId, assistantParts, dependencies);
    }

    return recordFailure(
      generationId,
      asError(error),
      assistantParts,
      dependencies,
    );
  } finally {
    await unsubscribe();
  }
}
