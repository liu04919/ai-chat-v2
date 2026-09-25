import type { GenerationEventDto } from "@ai-chat/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_CACHED_GENERATION_PROJECTIONS, useGenerationProjectionStore } from "./generation-projection-store";

const conversationId = "conversation_123";
const generationId = "generation_123";

const entries = (...events: GenerationEventDto[]) => events.map((event, index) => ({
  cursor: `100-${index}`, event,
}));

const delta = (cursor: string, text: string, id = generationId) => ({
  cursor, event: { type: "text.delta" as const, generationId: id, partId: "text_1", delta: text },
});

describe("Generation projection store", () => {
  beforeEach(() => {
    useGenerationProjectionStore.setState({ projections: {} });
  });

  it("SSE 连接不冒充 started，图片断线重连后仍记得已开始", () => {
    const store = useGenerationProjectionStore.getState();
    store.start(conversationId, generationId);
    store.setConnected(conversationId, generationId);
    expect(
      useGenerationProjectionStore.getState().projections[conversationId],
    ).toMatchObject({ status: "connecting", hasStarted: false });
    store.apply(conversationId, generationId, entries({ type: "generation.started", generationId }));
    store.setReconnecting(conversationId, generationId);
    store.setConnected(conversationId, generationId);
    expect(
      useGenerationProjectionStore.getState().projections[conversationId],
    ).toMatchObject({ status: "running", hasStarted: true, parts: [] });
  });

  it("通过 Immer 更新并清理会话投影", () => {
    useGenerationProjectionStore.getState().start(conversationId, generationId);
    useGenerationProjectionStore.getState().apply(conversationId, generationId, entries(
      { type: "generation.started", generationId },
      {
        type: "text.delta",
        generationId,
        partId: "text_1",
        delta: "你好",
      },
    ));
    useGenerationProjectionStore.getState().setReconnecting(conversationId, generationId);
    useGenerationProjectionStore.getState().setConnected(conversationId, generationId);

    expect(
      useGenerationProjectionStore.getState().projections[conversationId],
    ).toEqual({
      conversationId,
      generationId,
      status: "running",
      hasStarted: true,
      lastEventId: "100-1",
      lastVisited: 1,
      parts: [{ id: "text_1", type: "text", text: "你好" }],
    });

    useGenerationProjectionStore.getState().clear(conversationId);

    expect(
      useGenerationProjectionStore.getState().projections[conversationId],
    ).toBeUndefined();
  });

  it.each([
    "generation.completed", "generation.failed", "generation.cancelled",
  ] as const)("%s 同步后按任务清理，不影响其他会话", (type) => {
    const store = useGenerationProjectionStore.getState();
    store.start(conversationId, generationId);
    store.start("other-conversation", "other-generation");
    store.apply(conversationId, generationId, entries({ type, generationId }));

    store.clearGeneration(conversationId, generationId);

    const { projections } = useGenerationProjectionStore.getState();
    expect(projections[conversationId]).toBeUndefined();
    expect(projections["other-conversation"]?.generationId).toBe("other-generation");
  });

  it("上一轮的终态同步晚到时，不删除下一轮投影", () => {
    const store = useGenerationProjectionStore.getState();
    store.start(conversationId, generationId);
    store.start(conversationId, "next-generation");
    store.apply(conversationId, "next-generation", entries({
      type: "text.delta", generationId: "next-generation",
      partId: "text-next", delta: "新回复",
    }));
    const before = useGenerationProjectionStore.getState();

    store.clearGeneration(conversationId, generationId);

    // 不匹配时不修改状态，也不触发一次无意义的状态通知。
    expect(useGenerationProjectionStore.getState()).toBe(before);
    expect(before.projections[conversationId]).toMatchObject({
      generationId: "next-generation",
      parts: [{ id: "text-next", type: "text", text: "新回复" }],
    });
  });

  it("投影不存在或已清理时，重复清理无副作用", () => {
    const store = useGenerationProjectionStore.getState();
    store.clearGeneration(conversationId, generationId);
    expect(useGenerationProjectionStore.getState().projections).toEqual({});

    store.start(conversationId, generationId);
    store.clearGeneration(conversationId, generationId);
    const cleared = useGenerationProjectionStore.getState();
    store.clearGeneration(conversationId, generationId);
    expect(useGenerationProjectionStore.getState()).toBe(cleared);
  });

  it("同一任务重新进入保留内容与游标，新任务则重置", () => {
    const store = useGenerationProjectionStore.getState();
    store.start(conversationId, generationId);
    store.apply(conversationId, generationId, [delta("100-0", "你好")]);
    store.start("other", "other-generation");
    store.start(conversationId, generationId);
    expect(useGenerationProjectionStore.getState().projections[conversationId]).toMatchObject({
      status: "connecting", hasStarted: true, lastEventId: "100-0", lastVisited: 3,
      parts: [{ text: "你好" }],
    });
    store.start(conversationId, "next-generation");
    expect(useGenerationProjectionStore.getState().projections[conversationId]).toMatchObject({
      generationId: "next-generation", status: "connecting", hasStarted: false,
      lastEventId: null, parts: [],
    });
  });

  it("超限淘汰最久未访问项，保留刚访问和当前项，淘汰后可从头恢复", () => {
    const store = useGenerationProjectionStore.getState();
    for (let i = 0; i < MAX_CACHED_GENERATION_PROJECTIONS; i++) {
      store.start(`c${i}`, `g${i}`);
      store.apply(`c${i}`, `g${i}`, [delta("100-0", `内容${i}`, `g${i}`)]);
    }
    // c0 被再次访问，最旧的是 c1，而不是最早创建的 c0。
    store.start("c0", "g0");
    store.start("new", "new-generation");
    const cached = useGenerationProjectionStore.getState().projections;
    expect(Object.keys(cached)).toHaveLength(MAX_CACHED_GENERATION_PROJECTIONS);
    expect(cached.c1).toBeUndefined();
    expect(cached.c0?.lastEventId).toBe("100-0");
    expect(cached.new).toBeDefined();
    store.start("c1", "g1");
    expect(useGenerationProjectionStore.getState().projections.c1)
      .toMatchObject({ lastEventId: null, parts: [] });
  });

  it("旧任务的 delta 与连接回调不影响新任务，已淘汰项也不会被复活", () => {
    const store = useGenerationProjectionStore.getState();
    store.start(conversationId, "new-generation");
    const before = useGenerationProjectionStore.getState();
    store.apply(conversationId, generationId, [delta("100-0", "旧")]);
    store.setReconnecting(conversationId, generationId);
    store.setConnected(conversationId, generationId);
    store.setConnectionError(conversationId, generationId);
    expect(useGenerationProjectionStore.getState()).toBe(before);
    store.clear(conversationId);
    store.apply(conversationId, "new-generation", [delta("100-1", "迟到", "new-generation")]);
    expect(useGenerationProjectionStore.getState().projections[conversationId]).toBeUndefined();
  });

  it("按数值比较 Redis ID，跳过重复和过期事件，并原子提交内容与游标", () => {
    const store = useGenerationProjectionStore.getState();
    store.start(conversationId, generationId);
    const observe = vi.fn();
    const unsubscribe = useGenerationProjectionStore.subscribe(observe);
    store.apply(conversationId, generationId, [
      delta("9-9", "你"), delta("10-0", "好"),
      delta("9-99", "过期"), delta("10-0", "重复"), delta("10-10", "！"),
    ]);
    expect(observe).toHaveBeenCalledOnce();
    expect(observe.mock.calls[0]![0].projections[conversationId]).toMatchObject({
      lastEventId: "10-10", parts: [{ text: "你好！" }],
    });
    store.apply(conversationId, generationId, [
      delta("9007199254740993-0", "大"), delta("9007199254740992-9", "过期"),
    ]);
    expect(useGenerationProjectionStore.getState().projections[conversationId]?.parts)
      .toMatchObject([{ text: "你好！大" }]);
    unsubscribe();
  });

  it("非法事件不能推进已应用游标", () => {
    const store = useGenerationProjectionStore.getState();
    store.start(conversationId, generationId);
    store.apply(conversationId, generationId, [delta("100-0", "保留")]);
    store.apply(conversationId, generationId, [{
      cursor: "100-1", event: {
        type: "tool.result", generationId, partId: "result", toolCallId: "missing", isError: false,
      },
    }]);
    expect(useGenerationProjectionStore.getState().projections[conversationId]).toMatchObject({
      status: "connection-error", lastEventId: "100-0", parts: [{ text: "保留" }],
    });
  });
});
