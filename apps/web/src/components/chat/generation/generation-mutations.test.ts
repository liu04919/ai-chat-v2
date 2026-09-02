import type {
  ConversationDetailResponse,
  CreateGenerationRequest,
} from "@ai-chat/contracts";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  conversationDetailQueryKey,
  conversationListQueryKey,
  prependConversation,
  type ClientConversationListResponse,
} from "../../../lib/conversations-client";
import { useGenerationProjectionStore } from "./generation-projection-store";
import { createGenerationMutationOptions } from "./use-create-generation";
import { cancelGenerationMutationOptions } from "./use-cancel-generation";
import { regenerateGenerationMutationOptions } from "./use-regenerate-generation";
import { initialConversationHistory, type ConversationHistoryData } from "../messages/conversation-history-query";

const conversationId = "conversation_123";
const generationId = "generation_123";
const queryKey = conversationDetailQueryKey(conversationId);
const now = "2026-08-31T00:00:00.000Z";
const conversation = {
  id: conversationId,
  mode: "chat" as const,
  title: "测试对话",
  createdAt: now,
  updatedAt: now,
};

function createRequest(type: "new" | "existing"): CreateGenerationRequest {
  return {
    target:
      type === "new"
        ? { type, conversationId, mode: "chat" }
        : { type, conversationId },
    userMessageId: "user_message_123",
    parts: [{ type: "text", text: "你好" }],
    reasoningEffort: "medium",
  };
}

function createResponse(request: CreateGenerationRequest): Response {
  return Response.json({
    conversationId: request.target.conversationId,
    generation: {
      id: generationId,
      userMessageId: request.userMessageId,
      status: "queued",
      reasoningEffort: request.reasoningEffort,
      createdAt: now,
    },
  });
}

function createDetail(running = false): ConversationDetailResponse {
  return {
    nextCursor: null,
    conversation,
    latestGeneration: running ? { id: generationId, status: "running" } : null,
    activeGeneration: running
      ? {
          id: generationId,
          status: "running",
          cancelRequestedAt: null,
        }
      : null,
    messages: [
      {
        id: "previous_user_message",
        role: "user",
        sequence: 5,
        parts: [{ type: "text", text: "上一条消息" }],
        createdAt: now,
      },
    ],
  };
}

let queryClient: QueryClient;

function setDetail(detail: ConversationDetailResponse) {
  queryClient.setQueryData(queryKey, initialConversationHistory(detail));
}

function getDetail() {
  return queryClient.getQueryData<ConversationHistoryData>(queryKey)?.pages[0];
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: 3, gcTime: Infinity },
    },
  });
  useGenerationProjectionStore.setState({ projections: {} });
});

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe("创建 Generation mutation", () => {
  it("立即写入草稿 Sidebar 占位，命令确认后结束 pending，不等待 AI", async () => {
    const deferred = Promise.withResolvers<Response>();
    const fetchMock = vi.fn().mockReturnValue(deferred.promise);
    vi.stubGlobal("fetch", fetchMock);
    const request = createRequest("new");
    const mutation = new MutationObserver(
      queryClient,
      createGenerationMutationOptions(queryClient),
    );

    const sending = mutation.mutate(request);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    expect(mutation.getCurrentResult().isPending).toBe(true);
    expect(mutation.getCurrentResult().variables).toEqual(request);
    expect(queryClient.getQueryData(conversationListQueryKey)).toMatchObject({
      conversations: [{ id: conversationId, title: "你好", isPending: true }],
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual(request);

    deferred.resolve(createResponse(request));
    await sending;

    expect(mutation.getCurrentResult().isSuccess).toBe(true);
    expect(mutation.getCurrentResult().isPending).toBe(false);
    expect(mutation.getCurrentResult().data?.generation.status).toBe("queued");
    expect(queryClient.getQueryData(conversationListQueryKey)).toMatchObject({
      conversations: [{ id: conversationId, isPending: false }],
    });
  });

  it("草稿发送失败只撤回自己的占位，不覆盖期间新增的其他会话", async () => {
    const deferred = Promise.withResolvers<Response>();
    const fetchMock = vi.fn().mockReturnValue(deferred.promise);
    vi.stubGlobal("fetch", fetchMock);
    const mutation = new MutationObserver(
      queryClient,
      createGenerationMutationOptions(queryClient),
    );
    const sending = mutation.mutate(createRequest("new"));
    const rejection = expect(sending).rejects.toThrow("生成服务暂时不可用");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    const otherConversation = { ...conversation, id: "other_conversation" };
    queryClient.setQueryData<ClientConversationListResponse>(
      conversationListQueryKey,
      (current) => prependConversation(current, otherConversation),
    );
    deferred.resolve(
      Response.json({ code: "QUEUE_UNAVAILABLE" }, { status: 503 }),
    );
    await rejection;

    expect(queryClient.getQueryData(conversationListQueryKey)).toEqual({
      conversations: [otherConversation],
    });
    expect(mutation.getCurrentResult().isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("已有会话先追加乐观消息，成功后由 activeGeneration 驱动订阅", async () => {
    const previousDetail = createDetail();
    setDetail(previousDetail);
    useGenerationProjectionStore
      .getState()
      .start(conversationId, "old_generation");
    const deferred = Promise.withResolvers<Response>();
    const fetchMock = vi.fn().mockReturnValue(deferred.promise);
    vi.stubGlobal("fetch", fetchMock);
    const request = createRequest("existing");
    const mutation = new MutationObserver(
      queryClient,
      createGenerationMutationOptions(queryClient),
    );

    const sending = mutation.mutate(request);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const optimistic =
      getDetail();
    expect(optimistic?.messages).toHaveLength(2);
    expect(optimistic?.messages[1]).toMatchObject({
      id: request.userMessageId,
      sequence: 6,
      parts: request.parts,
    });
    expect(
      useGenerationProjectionStore.getState().projections[conversationId],
    ).toBeUndefined();

    deferred.resolve(createResponse(request));
    await sending;

    const detail =
      getDetail();
    expect(detail?.activeGeneration).toEqual({
      id: generationId,
      status: "queued",
      cancelRequestedAt: null,
    });
    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    expect(mutation.getCurrentResult().isPending).toBe(false);
  });

  it("已有会话发送失败恢复详情，显式关闭自动重试", async () => {
    const previousDetail = createDetail();
    setDetail(previousDetail);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ code: "QUEUE_UNAVAILABLE" }, { status: 503 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const mutation = new MutationObserver(
      queryClient,
      createGenerationMutationOptions(queryClient),
    );

    await expect(mutation.mutate(createRequest("existing"))).rejects.toThrow(
      "生成服务暂时不可用",
    );

    expect(getDetail()).toEqual(previousDetail);
    expect(mutation.getCurrentResult().isPending).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("不存在详情时不会发请求，也不会造出空的 Query 缓存", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mutation = new MutationObserver(
      queryClient,
      createGenerationMutationOptions(queryClient),
    );

    await expect(mutation.mutate(createRequest("existing"))).rejects.toThrow(
      "对话详情尚未加载完成",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getDetail()).toBeUndefined();
  });

  it("发送失败只撤回乐观消息，保留发送期间新加载的历史页", async () => {
    const previousDetail = { ...createDetail(), nextCursor: 5 };
    setDetail(previousDetail);
    const deferred = Promise.withResolvers<Response>();
    const fetchMock = vi.fn().mockReturnValue(deferred.promise);
    vi.stubGlobal("fetch", fetchMock);
    const mutation = new MutationObserver(queryClient, createGenerationMutationOptions(queryClient));
    const sending = mutation.mutate(createRequest("existing"));
    const rejection = expect(sending).rejects.toThrow("生成服务暂时不可用");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const older = {
      ...createDetail(),
      messages: [{ ...createDetail().messages[0]!, id: "older", sequence: 1 }],
    };
    queryClient.setQueryData<ConversationHistoryData>(queryKey, (current) => ({
      pages: [...current!.pages, older], pageParams: [...current!.pageParams, 5],
    }));
    deferred.resolve(Response.json({ code: "QUEUE_UNAVAILABLE" }, { status: 503 }));
    await rejection;
    const history = queryClient.getQueryData<ConversationHistoryData>(queryKey)!;
    expect(history.pages).toEqual([previousDetail, older]);
    expect(history.pageParams).toEqual([null, 5]);
  });

  it("响应的会话 ID 不匹配时仍进入失败回滚", async () => {
    const previousDetail = createDetail();
    setDetail(previousDetail);
    const otherRequest = createRequest("existing");
    otherRequest.target.conversationId = "other_conversation";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(createResponse(otherRequest)),
    );
    const mutation = new MutationObserver(
      queryClient,
      createGenerationMutationOptions(queryClient),
    );

    await expect(mutation.mutate(createRequest("existing"))).rejects.toThrow(
      "不一致的 Conversation ID",
    );
    expect(getDetail()).toEqual(previousDetail);
  });
});

describe("重新生成 mutation", () => {
  const assistantMessageId = "assistant_message_123";

  beforeEach(() => {
    const detail = createDetail();
    detail.messages.push({
      id: assistantMessageId,
      role: "assistant",
      sequence: 6,
      parts: [{ id: "old-text", type: "text", text: "旧回答" }],
      createdAt: now,
    });
    setDetail(detail);
  });

  it("点击后立即乐观移除旧回答，命令确认后进入普通 active Generation", async () => {
    useGenerationProjectionStore
      .getState()
      .start(conversationId, "stale_generation");
    const deferred = Promise.withResolvers<Response>();
    const fetchMock = vi.fn().mockReturnValue(deferred.promise);
    vi.stubGlobal("fetch", fetchMock);
    const mutation = new MutationObserver(
      queryClient,
      regenerateGenerationMutationOptions(queryClient),
    );

    const regenerating = mutation.mutate({ conversationId, assistantMessageId });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    expect(getDetail()?.messages).toHaveLength(1);
    expect(getDetail()?.messages.at(-1)?.role).toBe("user");
    expect(
      useGenerationProjectionStore.getState().projections[conversationId],
    ).toBeUndefined();

    deferred.resolve(Response.json({
        conversationId,
        generation: {
          id: generationId,
          userMessageId: "previous_user_message",
          status: "queued",
          reasoningEffort: "medium",
          createdAt: now,
        },
      }));
    await regenerating;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      conversationId,
      assistantMessageId,
    });
    expect(getDetail()?.messages).toHaveLength(1);
    expect(getDetail()?.activeGeneration).toEqual({
      id: generationId,
      status: "queued",
      cancelRequestedAt: null,
    });
  });

  it("重新生成请求未成立时恢复乐观移除的旧回答", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ code: "QUEUE_UNAVAILABLE" }, { status: 503 }),
      ),
    );
    const mutation = new MutationObserver(
      queryClient,
      regenerateGenerationMutationOptions(queryClient),
    );

    await expect(
      mutation.mutate({ conversationId, assistantMessageId }),
    ).rejects.toThrow("生成服务暂时不可用，请重试");

    expect(getDetail()?.messages.at(-1)).toMatchObject({
      id: assistantMessageId,
      parts: [{ id: "old-text", type: "text", text: "旧回答" }],
    });
  });

  it("只允许当前详情中位于末尾的 Assistant Message", async () => {
    const detail = getDetail()!;
    detail.messages.push({
      id: "newer_user",
      role: "user",
      sequence: 7,
      parts: [{ type: "text", text: "后续问题" }],
      createdAt: now,
    });
    setDetail(detail);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mutation = new MutationObserver(
      queryClient,
      regenerateGenerationMutationOptions(queryClient),
    );

    await expect(
      mutation.mutate({ conversationId, assistantMessageId }),
    ).rejects.toThrow("只能重新生成当前对话的最新回答");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("停止 Generation mutation", () => {
  beforeEach(() => {
    setDetail(createDetail(true));
    useGenerationProjectionStore.getState().start(conversationId, generationId);
  });

  it("请求结束后不再 pending，但仍保留正在停止的服务端状态和流式投影", async () => {
    const deferred = Promise.withResolvers<Response>();
    const fetchMock = vi.fn().mockReturnValue(deferred.promise);
    vi.stubGlobal("fetch", fetchMock);
    const mutation = new MutationObserver(
      queryClient,
      cancelGenerationMutationOptions(queryClient),
    );
    const stopping = mutation.mutate({ conversationId, generationId });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(mutation.getCurrentResult().isPending).toBe(true);

    deferred.resolve(
      Response.json({
        generation: {
          id: generationId,
          status: "running",
          cancelRequestedAt: now,
        },
      }),
    );
    await stopping;

    expect(mutation.getCurrentResult().isSuccess).toBe(true);
    const detail =
      getDetail();
    expect(detail?.activeGeneration).toEqual({
      id: generationId,
      status: "running",
      cancelRequestedAt: now,
    });
    expect(
      useGenerationProjectionStore.getState().projections[conversationId],
    ).toBeDefined();
  });

  it("返回终态才清理当前投影并刷新消息", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          generation: {
            id: generationId,
            status: "cancelled",
            cancelRequestedAt: now,
          },
        }),
      ),
    );
    const mutation = new MutationObserver(
      queryClient,
      cancelGenerationMutationOptions(queryClient),
    );

    await mutation.mutate({ conversationId, generationId });

    const detail =
      getDetail();
    expect(detail?.activeGeneration).toBeNull();
    expect(
      useGenerationProjectionStore.getState().projections[conversationId],
    ).toBeUndefined();
    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
  });

  it("图片取消保留停止提示，不往消息缓存插入假 Assistant Message", async () => {
    const detail = createDetail(true);
    detail.conversation.mode = "image";
    setDetail(detail);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          generation: {
            id: generationId,
            status: "cancelled",
            cancelRequestedAt: now,
          },
        }),
      ),
    );
    const mutation = new MutationObserver(
      queryClient,
      cancelGenerationMutationOptions(queryClient),
    );
    await mutation.mutate({ conversationId, generationId });
    expect(
      getDetail()?.messages,
    ).toEqual(detail.messages);
    expect(
      getDetail()
        ?.latestGeneration,
    ).toEqual({ id: generationId, status: "cancelled" });
    expect(
      useGenerationProjectionStore.getState().projections[conversationId],
    ).toBeUndefined();
  });

  it("停止失败保留生成状态和投影，并结束 pending 以允许重试", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ code: "CANCEL_SIGNAL_UNAVAILABLE" }, { status: 503 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const mutation = new MutationObserver(
      queryClient,
      cancelGenerationMutationOptions(queryClient),
    );

    await expect(
      mutation.mutate({ conversationId, generationId }),
    ).rejects.toThrow("暂时无法停止生成");

    expect(mutation.getCurrentResult().isError).toBe(true);
    expect(mutation.getCurrentResult().isPending).toBe(false);
    expect(getDetail()).toEqual(createDetail(true));
    expect(
      useGenerationProjectionStore.getState().projections[conversationId],
    ).toBeDefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("旧停止请求迟到时，不清理新一轮 Generation 的缓存或投影", async () => {
    const deferred = Promise.withResolvers<Response>();
    const fetchMock = vi.fn().mockReturnValue(deferred.promise);
    vi.stubGlobal("fetch", fetchMock);
    const mutation = new MutationObserver(
      queryClient,
      cancelGenerationMutationOptions(queryClient),
    );
    const stopping = mutation.mutate({ conversationId, generationId });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    const newerDetail = createDetail(true);
    newerDetail.activeGeneration!.id = "newer_generation";
    setDetail(newerDetail);
    useGenerationProjectionStore
      .getState()
      .start(conversationId, "newer_generation");
    deferred.resolve(
      Response.json({
        generation: {
          id: generationId,
          status: "cancelled",
          cancelRequestedAt: now,
        },
      }),
    );
    await stopping;

    expect(getDetail()).toEqual(newerDetail);
    expect(
      useGenerationProjectionStore.getState().projections[conversationId]
        ?.generationId,
    ).toBe("newer_generation");
  });
});
