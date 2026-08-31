"use client";

import type { ConversationDetailResponse } from "@ai-chat/contracts";
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
import { cancelGeneration } from "../../../lib/generations-client";
import { useGenerationProjectionStore } from "./generation-projection-store";

type CancelGenerationVariables = {
  conversationId: string;
  generationId: string;
};

export function cancelGenerationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: ["cancel-generation"],
    retry: false,
    mutationFn: async ({ generationId }: CancelGenerationVariables) => {
      const response = await cancelGeneration(generationId);

      if (response.generation.id !== generationId) {
        throw new Error("服务端返回了不一致的 Generation ID");
      }

      return response;
    },
    onMutate: async ({ conversationId }) => {
      await queryClient.cancelQueries({
        queryKey: conversationDetailQueryKey(conversationId),
      });
    },
    onSuccess: (response, { conversationId }) => {
      const queryKey = conversationDetailQueryKey(conversationId);
      const { id, status, cancelRequestedAt } = response.generation;
      const activeGeneration =
        status === "queued" || status === "running"
          ? { id, status, cancelRequestedAt }
          : null;

      queryClient.setQueryData<ConversationDetailResponse>(
        queryKey,
        (current) => {
          if (!current || current.activeGeneration?.id !== id) {
            return current;
          }

          return {
            ...current,
            activeGeneration,
            latestGeneration: { id, status },
          };
        },
      );

      // 收到停止请求不等于 Worker 已结束；只在服务端返回终态时清理投影。
      if (!activeGeneration) {
        const store = useGenerationProjectionStore.getState();
        if (store.projections[conversationId]?.generationId === id) {
          store.clear(conversationId);
        }
        void queryClient.invalidateQueries({ queryKey });
        void queryClient.invalidateQueries({
          queryKey: conversationListQueryKey,
        });
      }
    },
    onError: (_error, { conversationId }) => {
      void queryClient.invalidateQueries({
        queryKey: conversationDetailQueryKey(conversationId),
      });
    },
  });
}

export function useCancelGeneration() {
  const queryClient = useQueryClient();
  return useMutation(cancelGenerationMutationOptions(queryClient));
}
