import { beforeEach, describe, expect, it } from "vitest";

import { useGenerationProjectionStore } from "./generation-projection-store";

const conversationId = "conversation_123";
const generationId = "generation_123";

describe("Generation projection store", () => {
  beforeEach(() => {
    useGenerationProjectionStore.setState({ projections: {} });
  });

  it("SSE 连接不冒充 started，图片断线重连后仍记得已开始", () => {
    const store = useGenerationProjectionStore.getState();
    store.start(conversationId, generationId);
    store.setConnected(conversationId);
    expect(
      useGenerationProjectionStore.getState().projections[conversationId],
    ).toMatchObject({ status: "connecting", hasStarted: false });
    store.apply(conversationId, [{ type: "generation.started", generationId }]);
    store.setReconnecting(conversationId);
    store.setConnected(conversationId);
    expect(
      useGenerationProjectionStore.getState().projections[conversationId],
    ).toMatchObject({ status: "running", hasStarted: true, parts: [] });
  });

  it("通过 Immer 更新并清理会话投影", () => {
    useGenerationProjectionStore.getState().start(conversationId, generationId);
    useGenerationProjectionStore.getState().apply(conversationId, [
      { type: "generation.started", generationId },
      {
        type: "text.delta",
        generationId,
        partId: "text_1",
        delta: "你好",
      },
    ]);
    useGenerationProjectionStore.getState().setReconnecting(conversationId);
    useGenerationProjectionStore.getState().setConnected(conversationId);

    expect(
      useGenerationProjectionStore.getState().projections[conversationId],
    ).toEqual({
      conversationId,
      generationId,
      status: "running",
      hasStarted: true,
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
    store.apply(conversationId, [{ type, generationId }]);

    store.clearGeneration(conversationId, generationId);

    const { projections } = useGenerationProjectionStore.getState();
    expect(projections[conversationId]).toBeUndefined();
    expect(projections["other-conversation"]?.generationId).toBe("other-generation");
  });

  it("上一轮的终态同步晚到时，不删除下一轮投影", () => {
    const store = useGenerationProjectionStore.getState();
    store.start(conversationId, generationId);
    store.start(conversationId, "next-generation");
    store.apply(conversationId, [{
      type: "text.delta", generationId: "next-generation",
      partId: "text-next", delta: "新回复",
    }]);
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
});
