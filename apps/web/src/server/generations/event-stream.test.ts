import type { GenerationEventReader } from "@ai-chat/event-store";
import { describe, expect, it, vi } from "vitest";

import { openGenerationEventStreamForOwner } from "./event-stream";

const ownerId = "owner-1";
const generationId = "generation-1";

function createReader() {
  return {
    read: vi.fn<GenerationEventReader["read"]>().mockResolvedValue([]),
    readBlocking: vi.fn<GenerationEventReader["readBlocking"]>(),
    close: vi.fn<GenerationEventReader["close"]>().mockResolvedValue(undefined),
  };
}

describe("Generation SSE 数据库终态兜底", () => {
  it("重连时 Redis 已没有可补发事件，发送无游标终态通知并关流", async () => {
    const reader = createReader();
    const stream = await openGenerationEventStreamForOwner(ownerId, generationId, "100-0", {
      findGeneration: async () => ({ id: generationId, status: "completed" }),
      createReader: () => reader,
    });

    await expect(new Response(stream).text()).resolves.toBe(
      `event: generation.terminal\ndata: {"generationId":"${generationId}","status":"completed"}\n\n`,
    );
    expect(reader.read).toHaveBeenCalledWith({ generationId, afterCursor: "100-0", limit: 100 });
    expect(reader.readBlocking).not.toHaveBeenCalled();
    expect(reader.close).toHaveBeenCalledOnce();
  });

  it("实时流读超时后查数据库，生成仍运行时发心跳，已结束时关流", async () => {
    const reader = createReader();
    reader.readBlocking.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const findGeneration = vi.fn()
      .mockResolvedValueOnce({ id: generationId, status: "running" })
      .mockResolvedValueOnce({ id: generationId, status: "running" })
      .mockResolvedValueOnce({ id: generationId, status: "failed" });
    const stream = await openGenerationEventStreamForOwner(ownerId, generationId, undefined, {
      findGeneration,
      createReader: () => reader,
    });

    await expect(new Response(stream).text()).resolves.toBe(
      `: keep-alive\n\nevent: generation.terminal\ndata: {"generationId":"${generationId}","status":"failed"}\n\n`,
    );
    expect(findGeneration.mock.calls).toEqual([
      [ownerId, generationId],
      [ownerId, generationId],
      [ownerId, generationId],
    ]);
    expect(reader.close).toHaveBeenCalledOnce();
  });
});
