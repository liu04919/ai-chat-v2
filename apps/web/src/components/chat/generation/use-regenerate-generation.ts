"use client";

import type { RegenerateGenerationRequest } from "@ai-chat/contracts";
import {
  mutationOptions,
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import {
  conversationDetailQueryKey,
  conversationListQueryKey,
} from "../../../lib/conversations-client";
import { regenerateGeneration } from "../../../lib/generations-client";
import {
  invalidateConversationHistory,
  type ConversationHistoryData,
  updateConversationHead,
} from "../messages/conversation-history-query";
import { useGenerationProjectionStore } from "./generation-projection-store";

export function regenerateGenerationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: ["regenerate-generation"],
    retry: false,
    mutationFn: async (request: RegenerateGenerationRequest) => {
      const response = await regenerateGeneration(request);

      if (response.conversationId !== request.conversationId) {
        throw new Error("服务端返回了不一致的 Conversation ID");
      }

      return response;
    },
    onMutate: async (request) => {
      const queryKey = conversationDetailQueryKey(request.conversationId);
      await queryClient.cancelQueries({ queryKey });
      const history = queryClient.getQueryData<ConversationHistoryData>(queryKey);
      const detail = history?.pages[0];
      const latestMessage = detail?.messages.at(-1);

      if (
        !detail ||
        detail.conversation.mode !== "chat" ||
        detail.activeGeneration ||
        latestMessage?.role !== "assistant" ||
        latestMessage.id !== request.assistantMessageId
      ) {
        throw new Error("只能重新生成当前对话的最新回答");
      }

      useGenerationProjectionStore.getState().clear(request.conversationId);
    },
    onSuccess: (response, request) => {
      const { id, status } = response.generation;
      updateConversationHead(queryClient, request.conversationId, (current) => ({
        ...current,
        activeGeneration:
          status === "queued" || status === "running"
            ? {
                id,
                status,
                cancelRequestedAt: null,
                replacesAssistantMessageId: request.assistantMessageId,
              }
            : null,
        latestGeneration: { id, status },
      }));
      invalidateConversationHistory(queryClient, request.conversationId);
      void queryClient.invalidateQueries({ queryKey: conversationListQueryKey });
    },
    onError: (_error, request) => {
      invalidateConversationHistory(queryClient, request.conversationId);
    },
  });
}

export function useRegenerateGeneration() {
  const queryClient = useQueryClient();
  return useMutation(regenerateGenerationMutationOptions(queryClient));
}
