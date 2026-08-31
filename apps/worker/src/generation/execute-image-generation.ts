import { randomUUID } from "node:crypto";

import { ATTACHMENT_MAX_SIZE_BYTES } from "@ai-chat/contracts";
import {
  cancelGenerationExecution,
  completeImageGenerationExecution,
  failGenerationExecution,
  isGenerationCancellationRequested,
  type ClaimedGenerationExecution,
} from "@ai-chat/db";
import type {
  GenerationCancellationSubscriber,
  GenerationEventWriter,
} from "@ai-chat/event-store";
import type { ObjectStorage } from "@ai-chat/storage";

import type { ImageModel } from "../llm/image-model";
import { buildImageModelRequest } from "./image-context-builder";

export type ExecuteImageGenerationDependencies = {
  imageModel: ImageModel;
  cancellationSubscriber: GenerationCancellationSubscriber;
  eventWriter: GenerationEventWriter;
  objectStorage: Pick<
    ObjectStorage,
    "readObject" | "writeObject" | "deleteObject"
  >;
  createAssistantMessageId?: () => string;
  now?: () => Date;
};

const imageExtensions = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);

export async function executeImageGeneration(
  execution: ClaimedGenerationExecution,
  dependencies: ExecuteImageGenerationDependencies,
) {
  const generationId = execution.id;
  const now = dependencies.now ?? (() => new Date());
  const controller = new AbortController();
  let unsubscribe: (() => Promise<void>) | undefined;
  let objectKey: string | undefined;
  let committed = false;

  try {
    unsubscribe = await dependencies.cancellationSubscriber.subscribe(
      generationId,
      () => controller.abort("用户已请求停止生成"),
    );
    // 先订阅再查数据库，覆盖领取任务到订阅之间的取消窗口。
    if (await isGenerationCancellationRequested(generationId)) {
      controller.abort("用户已请求停止生成");
    }
    controller.signal.throwIfAborted();
    await dependencies.eventWriter.append({
      type: "generation.started",
      generationId,
    });

    const request = await buildImageModelRequest(
      execution,
      dependencies.objectStorage,
      controller.signal,
    );
    const image = await dependencies.imageModel.generate(request);
    controller.signal.throwIfAborted();
    const extension = imageExtensions.get(image.mediaType);
    if (
      !extension ||
      image.data.byteLength === 0 ||
      image.data.byteLength > ATTACHMENT_MAX_SIZE_BYTES
    ) {
      throw new Error("图片生成结果格式或大小不符合 Attachment 限制");
    }

    const attachmentId = randomUUID();
    const assistantMessageId = (
      dependencies.createAssistantMessageId ?? randomUUID
    )();
    const originalName = `generated-${attachmentId}.${extension}`;
    objectKey = `attachments/${attachmentId}/${originalName}`;
    await dependencies.objectStorage.writeObject({
      objectKey,
      data: image.data,
      contentType: image.mediaType,
      abortSignal: controller.signal,
    });
    controller.signal.throwIfAborted();

    committed = await completeImageGenerationExecution({
      generationId,
      assistantMessageId,
      attachment: {
        id: attachmentId,
        objectKey,
        originalName,
        mediaType: image.mediaType,
        sizeBytes: image.data.byteLength,
      },
      now: now(),
    });
    if (!committed) {
      throw new Error("Generation 已不能完成图片落库");
    }

    await dependencies.eventWriter.append({
      type: "generation.completed",
      generationId,
    });
    return { kind: "completed", assistantMessageId } as const;
  } catch (error) {
    // 终态事件发布失败也不能删除已进入消息历史的图片。
    if (committed) {
      throw error;
    }

    let cleanupError: unknown;
    if (objectKey) {
      try {
        // 仅清理本次执行创建且尚未发布的对象，不动参考图。
        await dependencies.objectStorage.deleteObject(objectKey);
      } catch (failure) {
        cleanupError = failure;
      }
    }

    try {
      // SQL 条件与取消请求互斥；取消已到达时不覆盖成 failed。
      const failed = await failGenerationExecution({
        generationId,
        errorCode: "IMAGE_GENERATION_FAILED",
        now: now(),
      });
      if (failed) {
        await dependencies.eventWriter.append({
          type: "generation.failed",
          generationId,
        });
      } else if (await isGenerationCancellationRequested(generationId)) {
        const cancelled = await cancelGenerationExecution({
          generationId,
          assistantMessageId: null,
          assistantParts: [],
          now: now(),
        });
        if (!cancelled) {
          throw new Error("Generation 已不再处于待取消状态");
        }
        await dependencies.eventWriter.append({
          type: "generation.cancelled",
          generationId,
        });
        if (!cleanupError) {
          return { kind: "cancelled", assistantMessageId: null } as const;
        }
      }
    } catch (recordingError) {
      throw new AggregateError(
        [error, cleanupError, recordingError].filter(Boolean),
        "图片生成中断，记录终态时再次出错",
      );
    }
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "图片生成中断，清理未发布对象失败",
      );
    }
    throw error;
  } finally {
    await unsubscribe?.();
  }
}
