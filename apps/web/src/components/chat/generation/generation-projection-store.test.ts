import { beforeEach, describe, expect, it } from "vitest";

import { useGenerationProjectionStore } from "./generation-projection-store";

const conversationId = "conversation_123";
const generationId = "generation_123";

describe("Generation projection store", () => {
  beforeEach(() => {
    useGenerationProjectionStore.setState({ projections: {} });
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
    useGenerationProjectionStore
      .getState()
      .setReconnecting(conversationId);
    useGenerationProjectionStore.getState().setConnected(conversationId);

    expect(
      useGenerationProjectionStore.getState().projections[conversationId],
    ).toEqual({
      conversationId,
      generationId,
      status: "running",
      parts: [{ id: "text_1", type: "text", text: "你好" }],
    });

    useGenerationProjectionStore.getState().clear(conversationId);

    expect(
      useGenerationProjectionStore.getState().projections[conversationId],
    ).toBeUndefined();
  });
});
