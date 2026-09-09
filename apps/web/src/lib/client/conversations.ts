import {
  conversationDetailResponseSchema,
  conversationListResponseSchema,
  conversationSummarySchema,
  deleteConversationResponseSchema,
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
  options: { before?: number; signal?: AbortSignal } = {},
): Promise<ConversationDetailResponse> {
  const query = options.before === undefined ? "" : `?before=${options.before}`;
  const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}${query}`, {
    signal: options.signal,
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("无法加载对话");
  }

  return conversationDetailResponseSchema.parse(await response.json());
}

export async function setConversationPinned(
  conversationId: string,
  pinned: boolean,
): Promise<ConversationSummaryDto> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/pin`,
    { method: pinned ? "PUT" : "DELETE" },
  );

  if (!response.ok) {
    throw new Error(pinned ? "无法置顶对话" : "无法取消置顶");
  }

  return conversationSummarySchema.parse(await response.json());
}

export async function deleteConversation(
  conversationId: string,
): Promise<void> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
    { method: "DELETE" },
  );

  if (!response.ok) {
    throw new Error("无法删除对话");
  }

  deleteConversationResponseSchema.parse(await response.json());
}

function compareConversations(
  left: ClientConversationSummary,
  right: ClientConversationSummary,
): number {
  if (left.pinnedAt || right.pinnedAt) {
    if (!left.pinnedAt) return 1;
    if (!right.pinnedAt) return -1;
    const pinnedDifference =
      new Date(right.pinnedAt).getTime() - new Date(left.pinnedAt).getTime();
    if (pinnedDifference !== 0) return pinnedDifference;
  }

  const updatedDifference =
    new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  return updatedDifference !== 0
    ? updatedDifference
    : right.id.localeCompare(left.id);
}

export function replaceConversation(
  current: ClientConversationListResponse | undefined,
  conversation: ConversationSummaryDto,
): ClientConversationListResponse {
  return {
    conversations: (current?.conversations.map((candidate) =>
      candidate.id === conversation.id
        ? { ...conversation, isPending: candidate.isPending }
        : candidate,
    ) ?? []).toSorted(compareConversations),
  };
}

export function updateConversationPinned(
  current: ClientConversationListResponse | undefined,
  conversationId: string,
  pinnedAt: string | null,
): ClientConversationListResponse {
  return {
    conversations: (current?.conversations.map((conversation) =>
      conversation.id === conversationId
        ? { ...conversation, pinnedAt }
        : conversation,
    ) ?? []).toSorted(compareConversations),
  };
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
