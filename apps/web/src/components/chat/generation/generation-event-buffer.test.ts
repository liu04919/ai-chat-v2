import type { GenerationEventDto } from "@ai-chat/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createGenerationEventBuffer,
  type FrameScheduler,
} from "./generation-event-buffer";

function createFakeScheduler() {
  let callback: (() => void) | null = null;
  const scheduler: FrameScheduler = {
    request: vi.fn((nextCallback) => {
      callback = nextCallback;
      return 7;
    }),
    cancel: vi.fn(),
  };

  return {
    scheduler,
    flushFrame() {
      const scheduledCallback = callback;
      callback = null;
      scheduledCallback?.();
    },
  };
}

describe("Generation event frame buffer", () => {
  it("同一帧只调度一次，并按入队顺序批量 flush", () => {
    const { scheduler, flushFrame } = createFakeScheduler();
    const flush = vi.fn();
    const buffer = createGenerationEventBuffer(flush, scheduler);
    const events: GenerationEventDto[] = [
      { type: "generation.started", generationId: "generation_123" },
      {
        type: "text.delta",
        generationId: "generation_123",
        partId: "text_1",
        delta: "你好",
      },
    ];

    events.forEach((event) => buffer.enqueue(event));

    expect(scheduler.request).toHaveBeenCalledTimes(1);
    expect(flush).not.toHaveBeenCalled();

    flushFrame();

    expect(flush).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith(events);
  });

  it("dispose 会取消尚未执行的帧并丢弃缓冲事件", () => {
    const { scheduler, flushFrame } = createFakeScheduler();
    const flush = vi.fn();
    const buffer = createGenerationEventBuffer(flush, scheduler);

    buffer.enqueue({
      type: "generation.started",
      generationId: "generation_123",
    });
    buffer.dispose();
    flushFrame();

    expect(scheduler.cancel).toHaveBeenCalledWith(7);
    expect(flush).not.toHaveBeenCalled();
  });
});
