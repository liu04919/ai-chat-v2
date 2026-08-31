"use client";

import type {
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
import {
  invalidateConversationHistory,
  updateConversationHead,
  type ConversationHistoryData,
} from "../messages/conversation-history-query";

function nextMessageSequence(messages: readonly MessageDto[]): number {
  return (
    messages.reduce(
      (largest, message) => Math.max(largest, message.sequence),
      -1,
    ) + 1
  );
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
      const previousHistory = queryClient.getQueryData<ConversationHistoryData>(queryKey);
      const previousDetail = previousHistory?.pages[0];

      if (!previousDetail) {
        throw new Error("对话详情尚未加载完成");
      }

      updateConversationHead(queryClient, target.conversationId, () => ({
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
      }));

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
        const { id, status } = response.generation;
        updateConversationHead(
          queryClient, conversationId,
          (current) => {
            const activeGeneration =
              status === "queued" || status === "running"
                ? { id, status, cancelRequestedAt: null }
                : null;

            return {
              ...current,
              activeGeneration,
              latestGeneration: { id, status },
            };
          },
        );
        invalidateConversationHistory(queryClient, conversationId);
      }

      // 命令确认后即可结束 pending，不等待详情刷新或 AI 生成完成。
      void queryClient.invalidateQueries({
        queryKey: conversationListQueryKey,
      });
    },
    onError: (_error, { target, userMessageId }, previousDetail) => {
      if (target.type === "new") {
        queryClient.setQueryData<ClientConversationListResponse>(
          conversationListQueryKey,
          (current) => removeConversation(current, target.conversationId),
        );
      } else if (previousDetail) {
        updateConversationHead(queryClient, target.conversationId, (current) => ({
          ...current,
          messages: current.messages.filter((message) => message.id !== userMessageId),
        }));
      }
    },
  });
}

export function useCreateGeneration() {
  const queryClient = useQueryClient();
  return useMutation(createGenerationMutationOptions(queryClient));
}
