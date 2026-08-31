"use client";

import type {
  ConversationDetailResponse,
  CreateGenerationRequest,
  MessageDto,
} from "@ai-chat/contracts";
import {
  mutationOptions,
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { createConversationTitle } from "../../../lib/conversation-title";
import {
  confirmConversation,
  conversationDetailQueryKey,
  conversationListQueryKey,
  prependConversation,
  removeConversation,
  type ClientConversationListResponse,
} from "../../../lib/conversations-client";
import { createGeneration } from "../../../lib/generations-client";
import { useGenerationProjectionStore } from "./generation-projection-store";

function nextMessageSequence(messages: readonly MessageDto[]): number {
  return messages.reduce(
    (largest, message) => Math.max(largest, message.sequence),
    -1,
  ) + 1;
}

export function createGenerationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: ["create-generation"],
    retry: false,
    mutationFn: async (request: CreateGenerationRequest) => {
      const response = await createGeneration(request);

      if (response.conversationId !== request.target.conversationId) {
        throw new Error("服务端返回了不一致的 Conversation ID");
      }

      return response;
    },
    onMutate: async (request) => {
      const { target, userMessageId, parts } = request;
      const now = new Date().toISOString();

      if (target.type === "new") {
        await queryClient.cancelQueries({
          queryKey: conversationListQueryKey,
        });
        queryClient.setQueryData<ClientConversationListResponse>(
          conversationListQueryKey,
          (current) =>
            prependConversation(current, {
              id: target.conversationId,
              mode: target.mode,
              title: createConversationTitle(parts),
              createdAt: now,
              updatedAt: now,
              isPending: true,
            }),
        );
        return;
      }

      const queryKey = conversationDetailQueryKey(target.conversationId);
      useGenerationProjectionStore.getState().clear(target.conversationId);
      await queryClient.cancelQueries({ queryKey });
      const previousDetail =
        queryClient.getQueryData<ConversationDetailResponse>(queryKey);

      if (!previousDetail) {
        throw new Error("对话详情尚未加载完成");
      }

      queryClient.setQueryData<ConversationDetailResponse>(queryKey, {
        ...previousDetail,
        messages: [
          ...previousDetail.messages,
          {
            id: userMessageId,
            role: "user",
            sequence: nextMessageSequence(previousDetail.messages),
            parts,
            createdAt: now,
          },
        ],
      });

      return previousDetail;
    },
    onSuccess: (response, { target }) => {
      const conversationId = target.conversationId;

      if (target.type === "new") {
        queryClient.setQueryData<ClientConversationListResponse>(
          conversationListQueryKey,
          (current) => confirmConversation(current, conversationId),
        );
      } else {
        const queryKey = conversationDetailQueryKey(conversationId);
        const { id, status } = response.generation;
        queryClient.setQueryData<ConversationDetailResponse>(
          queryKey,
          (current) => {
            if (!current) {
              return current;
            }

            const activeGeneration =
              status === "queued" || status === "running"
                ? { id, status, cancelRequestedAt: null }
                : null;

            return { ...current, activeGeneration };
          },
        );
        void queryClient.invalidateQueries({ queryKey });
      }

      // 命令确认后即可结束 pending，不等待详情刷新或 AI 生成完成。
      void queryClient.invalidateQueries({
        queryKey: conversationListQueryKey,
      });
    },
    onError: (_error, { target }, previousDetail) => {
      if (target.type === "new") {
        queryClient.setQueryData<ClientConversationListResponse>(
          conversationListQueryKey,
          (current) => removeConversation(current, target.conversationId),
        );
      } else if (previousDetail) {
        queryClient.setQueryData(
          conversationDetailQueryKey(target.conversationId),
          previousDetail,
        );
      }
    },
  });
}

export function useCreateGeneration() {
  const queryClient = useQueryClient();
  return useMutation(createGenerationMutationOptions(queryClient));
}
