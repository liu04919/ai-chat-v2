import type {
  ConversationSummaryDto,
  DeleteConversationResponse,
} from "@ai-chat/contracts";
import {
  deleteConversationRecordForOwner,
  setConversationPinnedForOwner,
} from "@ai-chat/db";
import type { GenerationCancellationPublisher } from "@ai-chat/event-store";
import type { ObjectStorage } from "@ai-chat/storage";

import { getAttachmentObjectStorage } from "./attachment-storage";
import { getGenerationCancellationInfrastructure } from "./generation-cancellation-infrastructure";
import { toConversationSummary } from "./conversations";

export class ConversationMutationError extends Error {
  constructor(readonly status: 404) {
    super("CONVERSATION_NOT_FOUND");
  }
}

export async function pinConversationForOwner(
  ownerId: string,
  conversationId: string,
  pinned: boolean,
  now = new Date(),
): Promise<ConversationSummaryDto> {
  const conversation = await setConversationPinnedForOwner({
    ownerId,
    conversationId,
    pinned,
    now,
  });

  if (!conversation) {
    throw new ConversationMutationError(404);
  }

  return toConversationSummary(conversation);
}

export async function deleteConversationForOwner(
  ownerId: string,
  conversationId: string,
  dependencies: {
    cancellationPublisher?: GenerationCancellationPublisher;
    storage?: Pick<ObjectStorage, "deleteObject">;
  } = {},
): Promise<DeleteConversationResponse> {
  const deleted = await deleteConversationRecordForOwner(
    ownerId,
    conversationId,
  );

  if (!deleted) {
    throw new ConversationMutationError(404);
  }

  const runningGenerationIds = deleted.activeGenerations.flatMap(
    (generation) => generation.status === "running" ? [generation.id] : [],
  );
  const cancellationPublisher = runningGenerationIds.length > 0
    ? dependencies.cancellationPublisher ??
      getGenerationCancellationInfrastructure().cancellationPublisher
    : null;
  const storage = deleted.attachmentObjectKeys.length > 0
    ? dependencies.storage ?? getAttachmentObjectStorage()
    : null;
  const cleanupResults = await Promise.allSettled([
    ...runningGenerationIds.map((generationId) =>
      cancellationPublisher!.publish(generationId),
    ),
    ...deleted.attachmentObjectKeys.map((objectKey) =>
      storage!.deleteObject(objectKey),
    ),
  ]);

  for (const result of cleanupResults) {
    if (result.status === "rejected") {
      // PostgreSQL 已经完成删除；外部清理失败不能把客户端伪装成未删除。
      console.error("删除 Conversation 后清理外部资源失败", result.reason);
    }
  }

  return { conversationId: deleted.conversationId };
}
