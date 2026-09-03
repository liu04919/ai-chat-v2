"use client";

import {
  mutationOptions,
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import {
  conversationDetailQueryKey,
  conversationListQueryKey,
  deleteConversation,
  removeConversation,
  replaceConversation,
  setConversationPinned,
  updateConversationPinned,
  type ClientConversationListResponse,
} from "@/lib/conversations-client";
import { useGenerationProjectionStore } from "../generation/generation-projection-store";

export function pinConversationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: ["pin-conversation"],
    retry: false,
    mutationFn: ({
      conversationId,
      pinned,
    }: {
      conversationId: string;
      pinned: boolean;
    }) => setConversationPinned(conversationId, pinned),
    onMutate: async ({ conversationId, pinned }) => {
      await queryClient.cancelQueries({ queryKey: conversationListQueryKey });
      const previous =
        queryClient.getQueryData<ClientConversationListResponse>(
          conversationListQueryKey,
        );
      queryClient.setQueryData<ClientConversationListResponse>(
        conversationListQueryKey,
        (current) =>
          updateConversationPinned(
            current,
            conversationId,
            pinned ? new Date().toISOString() : null,
          ),
      );
      return previous;
    },
    onSuccess: (conversation) => {
      queryClient.setQueryData<ClientConversationListResponse>(
        conversationListQueryKey,
        (current) => replaceConversation(current, conversation),
      );
    },
    onError: (_error, _variables, previous) => {
      if (previous) {
        queryClient.setQueryData(conversationListQueryKey, previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: conversationListQueryKey });
    },
  });
}

export function deleteConversationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: ["delete-conversation"],
    retry: false,
    mutationFn: (conversationId: string) => deleteConversation(conversationId),
    onMutate: async (conversationId) => {
      await queryClient.cancelQueries({ queryKey: conversationListQueryKey });
      const previous =
        queryClient.getQueryData<ClientConversationListResponse>(
          conversationListQueryKey,
        );
      queryClient.setQueryData<ClientConversationListResponse>(
        conversationListQueryKey,
        (current) => removeConversation(current, conversationId),
      );
      return previous;
    },
    onSuccess: (_response, conversationId) => {
      queryClient.removeQueries({
        queryKey: conversationDetailQueryKey(conversationId),
        exact: true,
      });
      useGenerationProjectionStore.getState().clear(conversationId);
    },
    onError: (_error, _conversationId, previous) => {
      if (previous) {
        queryClient.setQueryData(conversationListQueryKey, previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: conversationListQueryKey });
    },
  });
}

export function usePinConversation() {
  const queryClient = useQueryClient();
  return useMutation(pinConversationMutationOptions(queryClient));
}

export function useDeleteConversation() {
  const queryClient = useQueryClient();
  return useMutation(deleteConversationMutationOptions(queryClient));
}
