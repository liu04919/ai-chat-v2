import {
  conversationDetailResponseSchema,
  conversationListResponseSchema,
  type ConversationDetailResponse,
  type ConversationSummaryDto,
} from "@ai-chat/contracts";

export const conversationListQueryKey = ["conversations"] as const;

export function conversationDetailQueryKey(conversationId: string) {
  return ["conversation", conversationId] as const;
}

export type ClientConversationSummary = ConversationSummaryDto & {
  isPending?: boolean;
};

export type ClientConversationListResponse = {
  conversations: ClientConversationSummary[];
};

export async function fetchConversations(): Promise<ClientConversationListResponse> {
  const response = await fetch("/api/conversations");

  if (!response.ok) {
    throw new Error("无法加载对话");
  }

  return conversationListResponseSchema.parse(await response.json());
}

export async function fetchConversation(
  conversationId: string,
): Promise<ConversationDetailResponse> {
  const response = await fetch(`/api/conversations/${conversationId}`);

  if (!response.ok) {
    throw new Error("无法加载对话");
  }

  return conversationDetailResponseSchema.parse(await response.json());
}

export function prependConversation(
  current: ClientConversationListResponse | undefined,
  conversation: ClientConversationSummary,
): ClientConversationListResponse {
  return {
    conversations: [
      conversation,
      ...(current?.conversations.filter(
        (candidate) => candidate.id !== conversation.id,
      ) ?? []),
    ],
  };
}

export function removeConversation(
  current: ClientConversationListResponse | undefined,
  conversationId: string,
): ClientConversationListResponse {
  return {
    conversations:
      current?.conversations.filter(
        (conversation) => conversation.id !== conversationId,
      ) ?? [],
  };
}

export function confirmConversation(
  current: ClientConversationListResponse | undefined,
  conversationId: string,
): ClientConversationListResponse {
  return {
    conversations:
      current?.conversations.map((conversation) =>
        conversation.id === conversationId
          ? { ...conversation, isPending: false }
          : conversation,
      ) ?? [],
  };
}
