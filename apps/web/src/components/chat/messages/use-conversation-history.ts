"use client";

import type { ConversationDetailResponse } from "@ai-chat/contracts";
import {
  useInfiniteQuery,
  useIsFetching,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { conversationDetailQueryKey } from "../../../lib/client/conversations";
import {
  conversationHistoryOptions,
  historyMessages,
  initialConversationHistory,
  refreshConversationHistory,
} from "./conversation-history-query";

export function useConversationHistory(initialDetail: ConversationDetailResponse) {
  const conversationId = initialDetail.conversation.id;
  const queryClient = useQueryClient();
  const [entrySync, setEntrySync] = useState<{
    conversationId: string;
    succeeded: boolean;
  } | null>(null);
  const query = useInfiniteQuery({
    ...conversationHistoryOptions(conversationId),
    initialData: () => initialConversationHistory(initialDetail),
  });
  const isRefreshing = useIsFetching({
    queryKey: [...conversationDetailQueryKey(conversationId), "latest"],
  }) > 0;
  useEffect(() => {
    let disposed = false;
    // SSR/路由缓存用于立即展示；每次进入只同步一次最新详情，再允许流式对账。
    // 不能用旧缓存决定清理投影，否则会丢掉可续传的内容与游标。
    void refreshConversationHistory(queryClient, conversationId).then(
      () => {
        if (!disposed) setEntrySync({ conversationId, succeeded: true });
      },
      () => {
        if (!disposed) setEntrySync({ conversationId, succeeded: false });
      },
    );
    return () => {
      disposed = true;
    };
  }, [conversationId, queryClient]);

  const messages = useMemo(() => historyMessages(query.data), [query.data]);
  return {
    detail: query.data.pages[0]!,
    isSynchronized:
      entrySync?.conversationId === conversationId && entrySync.succeeded,
    synchronizationFailed:
      entrySync?.conversationId === conversationId && !entrySync.succeeded,
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
