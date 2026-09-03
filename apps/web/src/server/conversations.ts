import type {
  AssistantMessagePartsDto,
  AssistantMessageViewPartsDto,
  ConversationDetailResponse,
  ConversationSummaryDto,
} from "@ai-chat/contracts";
import {
  getConversationRecordForOwner,
  listConversationRecordsForOwner,
  type ConversationRecord,
} from "@ai-chat/db";

function toConversationSummary(
  conversation: ConversationRecord,
): ConversationSummaryDto {
  return {
    id: conversation.id,
    mode: conversation.mode,
    title: conversation.title,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

export function toAssistantMessageViewParts(
  parts: AssistantMessagePartsDto,
): AssistantMessageViewPartsDto {
  return parts.map((part) => {
    switch (part.type) {
      case "reasoning":
      case "text":
      case "attachment":
        return part;
      case "tool-call":
        return {
          id: part.id,
          type: part.type,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
        };
      case "tool-result":
        return {
          id: part.id,
          type: part.type,
          toolCallId: part.toolCallId,
          isError: part.isError,
        };
    }
  });
}

export async function listConversationsForOwner(
  ownerId: string,
): Promise<ConversationSummaryDto[]> {
  const conversations = await listConversationRecordsForOwner(ownerId);

  return conversations.map(toConversationSummary);
}

export async function getConversationForOwner(
  ownerId: string,
  conversationId: string,
  before?: number,
): Promise<ConversationDetailResponse | null> {
  const detail = await getConversationRecordForOwner(ownerId, conversationId, { before });

  if (!detail) {
    return null;
  }

  return {
    conversation: toConversationSummary(detail.conversation),
    latestGeneration: detail.latestGeneration,
    activeGeneration: detail.activeGeneration
      ? {
          ...detail.activeGeneration,
          cancelRequestedAt:
            detail.activeGeneration.cancelRequestedAt?.toISOString() ?? null,
        }
      : null,
    messages: detail.messages.map((message) =>
      message.role === "assistant"
        ? {
            ...message,
            parts: toAssistantMessageViewParts(message.parts),
            createdAt: message.createdAt.toISOString(),
          }
        : {
            ...message,
            createdAt: message.createdAt.toISOString(),
          },
    ),
    nextCursor: detail.nextCursor,
  };
}
