import type { ConversationDetailResponse } from "@ai-chat/contracts";
import { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationDetailQueryKey } from "../../../lib/client/conversations";
import { useGenerationProjectionStore } from "../generation/generation-projection-store";
import { initialConversationHistory, type ConversationHistoryData } from "./conversation-history-query";
import { useConversationHistory } from "./use-conversation-history";

const harness = vi.hoisted(() => ({
  state: null as unknown,
  client: null as QueryClient | null,
  setState: vi.fn(),
}));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: vi.fn(),
  useMemo: (calculate: () => unknown) => calculate(),
  useState: () => [harness.state, harness.setState],
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQueryClient: () => harness.client,
  useIsFetching: () => 0,
  useInfiniteQuery: (options: { queryKey: readonly unknown[]; initialData: () => ConversationHistoryData }) => {
    if (!harness.client!.getQueryData(options.queryKey)) {
      harness.client!.setQueryData(options.queryKey, options.initialData());
    }
    return { data: harness.client!.getQueryData(options.queryKey) };
  },
}));

const now = "2026-09-25T00:00:00.000Z";
function detail(activeId: string | null): ConversationDetailResponse {
  return {
    conversation: { id: "c1", mode: "chat", title: "测试", pinnedAt: null, createdAt: now, updatedAt: now },
    messages: [{ id: "user", role: "user", sequence: 0, parts: [{ type: "text", text: "你好" }], createdAt: now }],
    nextCursor: null,
    activeGeneration: activeId ? { id: activeId, status: "running", cancelRequestedAt: null } : null,
    latestGeneration: { id: activeId ?? "g1", status: activeId ? "running" : "completed" },
  };
}
function renderHistory(initial: ConversationDetailResponse) {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- 测试显式执行 effect，并以真实 QueryClient 验证请求与缓存更新。
  return useConversationHistory(initial);
}
function runEffect() { return vi.mocked(useEffect).mock.calls.at(-1)![0]() ?? (() => {}); }

beforeEach(() => {
  vi.clearAllMocks();
  harness.client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  harness.state = null;
  harness.setState.mockImplementation((next) => { harness.state = next; });
  useGenerationProjectionStore.setState({ projections: {} });
});
afterEach(() => {
  harness.client!.clear();
  vi.unstubAllGlobals();
});

describe("进入会话时以新详情对账", () => {
  it.each([null, "g1", "g2"])("缓存仍显示 g1 时，等待服务端确认 activeGeneration=%s", async (activeId) => {
    const old = detail("g1");
    harness.client!.setQueryData(conversationDetailQueryKey("c1"), initialConversationHistory(old));
    const pending = Promise.withResolvers<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    expect(renderHistory(old).isSynchronized).toBe(false);
    const cleanup = runEffect();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(renderHistory(old).isSynchronized).toBe(false);
    pending.resolve(Response.json(detail(activeId)));
    await vi.waitFor(() => expect(harness.setState).toHaveBeenCalledOnce());
    const result = renderHistory(old);
    expect(result.isSynchronized).toBe(true);
    expect(result.detail.activeGeneration?.id ?? null).toBe(activeId);
    // 重渲染只读状态；按会话 ID 建立的 effect 不因流式输出而重复请求。
    expect(vi.mocked(useEffect).mock.calls.at(-1)![1]).toEqual(["c1", harness.client]);
    expect(fetchMock).toHaveBeenCalledOnce();
    cleanup();
  });

  it("即使 SSR 首屏对象就是缓存对象，也重新确认服务端状态", async () => {
    const initial = detail(null);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(detail("g2"))));
    expect(renderHistory(initial).isSynchronized).toBe(false);
    const cleanup = runEffect();
    await vi.waitFor(() => expect(harness.setState).toHaveBeenCalledOnce());
    expect(renderHistory(initial).detail.activeGeneration?.id).toBe("g2");
    cleanup();
  });

  it("刷新失败保留历史与投影，不允许旧详情驱动清理或连接", async () => {
    const initial = detail("g1");
    const store = useGenerationProjectionStore.getState();
    store.start("c1", "g1");
    const cached = useGenerationProjectionStore.getState().projections.c1;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    renderHistory(initial);
    const cleanup = runEffect();
    await vi.waitFor(() => expect(harness.setState).toHaveBeenCalledOnce());
    const result = renderHistory(initial);
    expect(result.isSynchronized).toBe(false);
    expect(result.synchronizationFailed).toBe(true);
    expect(result.detail).toEqual(initial);
    expect(useGenerationProjectionStore.getState().projections.c1).toBe(cached);
    cleanup();
  });

  it("切走后旧刷新返回不能激活已卸载页面的订阅", async () => {
    const pending = Promise.withResolvers<Response>();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));
    renderHistory(detail("g1"));
    const cleanup = runEffect();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    cleanup();
    pending.resolve(Response.json(detail(null)));
    await vi.waitFor(() => expect(harness.client!.getQueryData<ConversationHistoryData>(conversationDetailQueryKey("c1"))?.pages[0]?.activeGeneration).toBeNull());
    expect(harness.setState).not.toHaveBeenCalled();
  });
});
