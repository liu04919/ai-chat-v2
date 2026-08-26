import type {
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

export async function listConversationsForOwner(
  ownerId: string,
): Promise<ConversationSummaryDto[]> {
  const conversations = await listConversationRecordsForOwner(ownerId);

  return conversations.map(toConversationSummary);
}

export async function getConversationForOwner(
  ownerId: string,
  conversationId: string,
): Promise<ConversationDetailResponse | null> {
  const detail = await getConversationRecordForOwner(ownerId, conversationId);

  if (!detail) {
    return null;
  }

  return {
    conversation: toConversationSummary(detail.conversation),
    activeGeneration: detail.activeGeneration,
  };
}
