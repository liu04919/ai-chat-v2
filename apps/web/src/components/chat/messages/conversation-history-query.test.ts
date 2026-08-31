import type { ConversationDetailResponse, MessageDto } from "@ai-chat/contracts";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationDetailQueryKey } from "../../../lib/conversations-client";
import { conversationHistoryOptions, historyMessages, initialConversationHistory, mergeConversationHead, refreshConversationHistory, type ConversationHistoryData } from "./conversation-history-query";

const now = "2026-09-01T00:00:00.000Z";
const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
const key = conversationDetailQueryKey("c1");
function page(start: number, end: number): ConversationDetailResponse {
  return {
    conversation: { id: "c1", mode: "chat", title: "测试", createdAt: now, updatedAt: now },
    activeGeneration: null, latestGeneration: null,
    messages: Array.from({ length: end - start + 1 }, (_, index): MessageDto => ({
      id: `m${start + index}`, sequence: start + index, role: "user",
      parts: [{ type: "text", text: `消息 ${start + index}` }], createdAt: now,
    })),
    nextCursor: start > 0 ? start : null,
  };
}
afterEach(() => { client.clear(); vi.unstubAllGlobals(); });

describe("会话消息分页缓存", () => {
  it("按最新页到最早页加载，渲染时按时间升序", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(page(0, 29)));
    vi.stubGlobal("fetch", fetchMock);
    client.setQueryData(key, initialConversationHistory(page(30, 59)));
    const observer = new InfiniteQueryObserver(client, conversationHistoryOptions("c1"));
    const unsubscribe = observer.subscribe(() => {});
    expect(fetchMock).not.toHaveBeenCalled();
    await observer.fetchNextPage();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/conversations/c1?before=30");
    const data = client.getQueryData<ConversationHistoryData>(key)!;
    expect(historyMessages(data).map((message) => message.sequence)).toEqual(Array.from({ length: 60 }, (_, index) => index));
    expect(observer.getCurrentResult().hasNextPage).toBe(false);
    unsubscribe();
  });
  it("生成完成只更新最新页，去重且保留之前加载的页面和游标", () => {
    const older = page(0, 29);
    const current = { pages: [page(30, 59), older], pageParams: [null, 30] };
    const latest = page(32, 61);
    latest.latestGeneration = { id: "g1", status: "completed" };
    const merged = mergeConversationHead(current, [latest]);
    expect(merged.pages[1]).toBe(older);
    expect(merged.pageParams).toEqual(current.pageParams);
    expect(merged.pages[0]?.nextCursor).toBe(30);
    expect(merged.pages[0]?.latestGeneration?.status).toBe("completed");
    expect(historyMessages(merged).map((message) => message.sequence)).toEqual(Array.from({ length: 62 }, (_, index) => index));
  });
  it("离开期间新增超过一页时补齐区间，不丢失中间消息", async () => {
    client.setQueryData(key, initialConversationHistory(page(0, 29)));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(page(65, 94)))
      .mockResolvedValueOnce(Response.json(page(35, 64)))
      .mockResolvedValueOnce(Response.json(page(5, 34)));
    vi.stubGlobal("fetch", fetchMock);
    await refreshConversationHistory(client, "c1");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/conversations/c1", "/api/conversations/c1?before=65", "/api/conversations/c1?before=35",
    ]);
    expect(historyMessages(client.getQueryData<ConversationHistoryData>(key)!).map((message) => message.sequence))
      .toEqual(Array.from({ length: 95 }, (_, index) => index));
  });
  it("最新页同步失败不清空历史缓存", async () => {
    const current = initialConversationHistory(page(0, 29));
    client.setQueryData(key, current);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    await expect(refreshConversationHistory(client, "c1")).rejects.toThrow("无法加载对话");
    expect(client.getQueryData(key)).toEqual(current);
  });
  it("终态同步取消迟到的历史请求，重试历史页也不会覆盖新消息", async () => {
    client.setQueryData(key, initialConversationHistory(page(30, 59)));
    const older = Promise.withResolvers<Response>();
    let olderSignal: AbortSignal | undefined;
    const fetchMock = vi.fn()
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        olderSignal = init.signal as AbortSignal;
        return older.promise;
      })
      .mockResolvedValueOnce(Response.json(page(32, 61)))
      .mockResolvedValueOnce(Response.json(page(0, 29)));
    vi.stubGlobal("fetch", fetchMock);
    const observer = new InfiniteQueryObserver(client, conversationHistoryOptions("c1"));
    const unsubscribe = observer.subscribe(() => {});
    const loading = observer.fetchNextPage();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await refreshConversationHistory(client, "c1");
    expect(olderSignal?.aborted).toBe(true);
    older.resolve(Response.json(page(0, 29)));
    await loading;
    expect(client.getQueryData<ConversationHistoryData>(key)?.pages[0]?.messages.at(-1)?.id).toBe("m61");
    await observer.fetchNextPage();
    expect(historyMessages(client.getQueryData<ConversationHistoryData>(key)!).map((message) => message.sequence))
      .toEqual(Array.from({ length: 62 }, (_, index) => index));
    unsubscribe();
  });
  it("新的终态请求不复用更早的刷新结果", async () => {
    client.setQueryData(key, initialConversationHistory(page(0, 29)));
    const stale = Promise.withResolvers<Response>();
    vi.stubGlobal("fetch", vi.fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(Response.json(page(2, 31))));
    const first = refreshConversationHistory(client, "c1").catch(() => undefined);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await refreshConversationHistory(client, "c1");
    stale.resolve(Response.json(page(1, 30)));
    await first;
    expect(client.getQueryData<ConversationHistoryData>(key)?.pages[0]?.messages.at(-1)?.id).toBe("m31");
  });
  it("失败的历史页可手动重试，不影响已加载消息", async () => {
    const current = initialConversationHistory(page(30, 59));
    client.setQueryData(key, current);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json(page(0, 29)));
    vi.stubGlobal("fetch", fetchMock);
    const observer = new InfiniteQueryObserver(client, conversationHistoryOptions("c1"));
    const unsubscribe = observer.subscribe(() => {});
    await observer.fetchNextPage();
    expect(observer.getCurrentResult().isFetchNextPageError).toBe(true);
    expect(client.getQueryData(key)).toEqual(current);
    await observer.fetchNextPage();
    expect(historyMessages(client.getQueryData<ConversationHistoryData>(key)!)).toHaveLength(60);
    unsubscribe();
  });
});
