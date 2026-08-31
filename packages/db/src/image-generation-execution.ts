import { createAttachmentUploadRequestSchema } from "@ai-chat/contracts";
import { eq, max } from "drizzle-orm";

import { getDatabase } from "./client";
import {
  attachments,
  conversations,
  generations,
  messages,
} from "./schema/index";

// 图片对象已保存到 R2；这里原子发布附件、消息和 Generation 终态。
export async function completeImageGenerationExecution(
  input: {
    generationId: string;
    assistantMessageId: string;
    attachment: {
      id: string;
      objectKey: string;
      originalName: string;
      mediaType: string;
      sizeBytes: number;
    };
    now: Date;
  },
  database: ReturnType<typeof getDatabase> = getDatabase(),
): Promise<boolean> {
  const metadata = createAttachmentUploadRequestSchema.parse({
    originalName: input.attachment.originalName,
    mediaType: input.attachment.mediaType,
    sizeBytes: input.attachment.sizeBytes,
  });
  if (!metadata.mediaType.startsWith("image/")) {
    throw new TypeError("生成结果必须是图片");
  }
  if (
    [
      input.generationId,
      input.assistantMessageId,
      input.attachment.id,
      input.attachment.objectKey,
    ].some((value) => !value.trim())
  ) {
    throw new TypeError("生成图片的标识不能为空");
  }

  return database.transaction(async (transaction) => {
    const [generation] = await transaction
      .select({
        conversationId: generations.conversationId,
        status: generations.status,
        cancelRequestedAt: generations.cancelRequestedAt,
      })
      .from(generations)
      .where(eq(generations.id, input.generationId))
      .for("update")
      .limit(1);
    if (
      !generation ||
      generation.status !== "running" ||
      generation.cancelRequestedAt
    ) {
      return false;
    }

    const [conversation] = await transaction
      .select({
        ownerId: conversations.ownerId,
        mode: conversations.mode,
      })
      .from(conversations)
      .where(eq(conversations.id, generation.conversationId))
      .limit(1);
    if (!conversation || conversation.mode !== "image") {
      throw new Error("只能完成图片会话的 Generation");
    }

    const [sequenceRow] = await transaction
      .select({ sequence: max(messages.sequence) })
      .from(messages)
      .where(eq(messages.conversationId, generation.conversationId));
    await transaction.insert(attachments).values({
      ...metadata,
      id: input.attachment.id,
      objectKey: input.attachment.objectKey,
      ownerId: conversation.ownerId,
      status: "ready",
      readyAt: input.now,
      linkedAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    });
    await transaction.insert(messages).values({
      id: input.assistantMessageId,
      conversationId: generation.conversationId,
      role: "assistant",
      parts: [
        {
          id: input.attachment.id,
          type: "attachment",
          attachmentId: input.attachment.id,
        },
      ],
      sequence: Number(sequenceRow?.sequence ?? -1) + 1,
      createdAt: input.now,
    });
    await transaction
      .update(generations)
      .set({
        status: "completed",
        assistantMessageId: input.assistantMessageId,
        finishedAt: input.now,
        errorCode: null,
      })
      .where(eq(generations.id, input.generationId));
    await transaction
      .update(conversations)
      .set({ updatedAt: input.now })
      .where(eq(conversations.id, generation.conversationId));
    return true;
  });
}
