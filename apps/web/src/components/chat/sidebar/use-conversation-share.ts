"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createConversationShare,
  deleteConversationShare,
  fetchConversationShare,
} from "@/lib/conversation-shares-client";

export function conversationShareQueryKey(conversationId: string) {
  return ["conversation-share", conversationId] as const;
}

export function useConversationShare(conversationId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const queryKey = conversationShareQueryKey(conversationId);
  const query = useQuery({
    queryKey,
    queryFn: () => fetchConversationShare(conversationId),
    enabled: enabled && Boolean(conversationId),
    staleTime: 0,
    retry: false,
  });
  const createMutation = useMutation({
    mutationKey: ["create-conversation-share", conversationId],
    mutationFn: () => createConversationShare(conversationId),
    retry: false,
    onSuccess: (share) => {
      queryClient.setQueryData(queryKey, { share });
    },
  });
  const deleteMutation = useMutation({
    mutationKey: ["delete-conversation-share", conversationId],
    mutationFn: () => deleteConversationShare(conversationId),
    retry: false,
    onSuccess: () => {
      queryClient.setQueryData(queryKey, { share: null });
    },
  });

  return { query, createMutation, deleteMutation };
}
