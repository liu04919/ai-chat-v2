import type { ConversationDetailResponse, MessageDto } from "@ai-chat/contracts";
import {
  infiniteQueryOptions,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";

import {
  conversationDetailQueryKey,
  fetchConversation,
} from "../../../lib/conversations-client";

export type ConversationHistoryData = InfiniteData<
  ConversationDetailResponse,
  number | null
>;

export function initialConversationHistory(
  detail: ConversationDetailResponse,
): ConversationHistoryData {
  return { pages: [detail], pageParams: [null] };
}

export function conversationHistoryOptions(conversationId: string) {
  return infiniteQueryOptions({
    queryKey: conversationDetailQueryKey(conversationId),
    queryFn: ({ pageParam, signal }) =>
      fetchConversation(conversationId, {
        before: pageParam ?? undefined,
        signal,
      }),
    initialPageParam: null as number | null,
    // pages 按最新页 → 最早页存放，渲染时才反转页顺序。
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}

export function historyMessages(
  data: Pick<ConversationHistoryData, "pages">,
): MessageDto[] {
  return data.pages.toReversed().flatMap((page) => page.messages);
}

export function updateConversationHead(
  queryClient: QueryClient,
  conversationId: string,
  update: (head: ConversationDetailResponse) => ConversationDetailResponse,
) {
  queryClient.setQueryData<ConversationHistoryData>(
    conversationDetailQueryKey(conversationId),
    (current) => current ? {
      ...current,
      pages: [update(current.pages[0]!), ...current.pages.slice(1)],
    } : current,
  );
}

export function mergeConversationHead(
  current: ConversationHistoryData | undefined,
  latestPages: ConversationDetailResponse[],
): ConversationHistoryData {
  const latest = latestPages[0]!;
  if (!current) return initialConversationHistory(latest);
  const head = current.pages[0]!;
  // 新页可能和旧页重叠。只扩展最新页，保留其他页及它们固定的 before 游标。
  const boundary = head.messages[0]?.sequence ?? Infinity;
  const messages = new Map(head.messages.map((message) => [message.id, message]));
  for (const page of latestPages.toReversed()) {
    for (const message of page.messages) {
      if (message.sequence >= boundary || head.messages.length === 0) {
        messages.set(message.id, message);
      }
    }
  }
  return {
    ...current,
    pages: [{
      ...latest,
      nextCursor: head.messages.length ? head.nextCursor : latest.nextCursor,
      messages: [...messages.values()].sort((a, b) => a.sequence - b.sequence),
    }, ...current.pages.slice(1)],
  };
}

export async function refreshConversationHistory(
  queryClient: QueryClient,
  conversationId: string,
) {
  const queryKey = conversationDetailQueryKey(conversationId);
  // 终态同步不能复用生成完成前发出的旧请求；展示数据只写入 history 缓存。
  await queryClient.cancelQueries({
    queryKey: [...queryKey, "latest"],
    exact: true,
  });
  const latestPages = await queryClient.query({
    queryKey: [...queryKey, "latest"],
    gcTime: 0,
    staleTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const current = queryClient.getQueryData<ConversationHistoryData>(queryKey);
      const lastKnown = current?.pages[0]?.messages.at(-1)?.sequence;
      let page = await fetchConversation(conversationId, { signal });
      const pages = [page];
      // 离开期间若新增超过一页，补齐新旧区间，不能把中间消息跳过去。
      while (
        lastKnown !== undefined &&
        page.nextCursor !== null &&
        page.messages[0]!.sequence > lastKnown
      ) {
        page = await fetchConversation(conversationId, {
          before: page.nextCursor,
          signal,
        });
        pages.push(page);
      }
      return pages;
    },
  });
  // 防止仍在返回的历史分页用旧的第一页覆盖刚同步的消息。
  // 已完成的历史页仍保留；取消中的页可以再次向上加载。
  await queryClient.cancelQueries({ queryKey, exact: true });
  queryClient.setQueryData<ConversationHistoryData>(queryKey,
    (current) => mergeConversationHead(current, latestPages),
  );
  return latestPages[0]!;
}

export function invalidateConversationHistory(
  queryClient: QueryClient,
  conversationId: string,
) {
  const queryKey = conversationDetailQueryKey(conversationId);
  void queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
  if (queryClient.getQueryCache().find({ queryKey, exact: true })?.isActive()) {
    void refreshConversationHistory(queryClient, conversationId).catch(() => {
      // 缓存与流式投影均保留，终态同步或重新进入会话时再读取。
    });
  }
}
