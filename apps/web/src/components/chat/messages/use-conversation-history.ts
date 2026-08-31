"use client";

import type { ConversationDetailResponse } from "@ai-chat/contracts";
import {
  useInfiniteQuery,
  useIsFetching,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { conversationDetailQueryKey } from "../../../lib/conversations-client";
import {
  conversationHistoryOptions,
  historyMessages,
  initialConversationHistory,
  refreshConversationHistory,
  type ConversationHistoryData,
} from "./conversation-history-query";

export function useConversationHistory(initialDetail: ConversationDetailResponse) {
  const conversationId = initialDetail.conversation.id;
  const queryClient = useQueryClient();
  const query = useInfiniteQuery({
    ...conversationHistoryOptions(conversationId),
    initialData: () => initialConversationHistory(initialDetail),
  });
  const isRefreshing = useIsFetching({
    queryKey: [...conversationDetailQueryKey(conversationId), "latest"],
  }) > 0;
  useEffect(() => {
    // 首次直接使用 SSR 的最新一页；重新进入已有缓存的会话则同步尾部。
    const cached = queryClient.getQueryData<ConversationHistoryData>(
      conversationDetailQueryKey(conversationId),
    );
    if (cached?.pages[0] !== initialDetail) {
      void refreshConversationHistory(queryClient, conversationId).catch(() => {
        // 暂时不可用时保留已有历史，后续终态同步仍可更新最新消息。
      });
    }
  }, [conversationId, initialDetail, queryClient]);

  const messages = useMemo(() => historyMessages(query.data), [query.data]);
  return {
    detail: query.data.pages[0]!,
    messages,
    hasOlder: query.hasNextPage,
    isLoadingOlder: query.isFetchingNextPage,
    olderError: query.isFetchNextPageError,
    loadOlder: async () => {
      if (query.hasNextPage && !query.isFetching && !isRefreshing) {
        await query.fetchNextPage({ cancelRefetch: false });
      }
    },
  };
}
