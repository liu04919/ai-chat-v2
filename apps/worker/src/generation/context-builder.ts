import type { ClaimedGenerationExecution } from "@ai-chat/db";
import type { ObjectStorage } from "@ai-chat/storage";

import type {
  ChatModelMessage,
  ChatModelRequest,
  ChatModelUserPart,
} from "../llm/chat-model";
import { parseChatModelProviderState } from "../llm/chat-model";

export const MODEL_ATTACHMENT_URL_TTL_SECONDS = 15 * 60;

type AttachmentUrlProvider = Pick<ObjectStorage, "createDownloadUrl">;

export async function buildChatModelRequest(
  execution: ClaimedGenerationExecution,
  storage: AttachmentUrlProvider,
): Promise<ChatModelRequest> {
  if (execution.mode !== "chat" || execution.reasoningEffort === null) {
    throw new Error("Chat Context Builder 只能处理 Chat Generation");
  }

  const attachmentParts = new Map<string, ChatModelUserPart>();

  await Promise.all(
    execution.attachments.map(async (attachment) => {
      if (attachment.status !== "ready") {
        throw new Error(`Attachment ${attachment.id} 尚未 ready`);
      }

      attachmentParts.set(attachment.id, {
        type: "file",
        url: await storage.createDownloadUrl(
          attachment.objectKey,
          MODEL_ATTACHMENT_URL_TTL_SECONDS,
        ),
        mediaType: attachment.mediaType,
        filename: attachment.originalName,
      });
    }),
  );

  const modelMessages: ChatModelMessage[] = execution.messages.map((message) => {
    if (message.role === "assistant") {
      const providerState = parseChatModelProviderState(message.providerState);

      if (message.providerState !== null && !providerState) {
        throw new Error(`Assistant Message ${message.id} 的 Provider State 无效`);
      }

      return {
        role: "assistant",
        parts: message.parts,
        ...(providerState ? { providerState } : {}),
      };
    }

    return {
      role: "user",
      parts: message.parts.map((part) => {
        if (part.type === "text") {
          return part;
        }

        const attachment = attachmentParts.get(part.attachmentId);

        if (!attachment) {
          throw new Error(`找不到 Attachment ${part.attachmentId}`);
        }

        return attachment;
      }),
    };
  });

  return {
    messages: modelMessages,
    reasoningEffort: execution.reasoningEffort,
  };
}
