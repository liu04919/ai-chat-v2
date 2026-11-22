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
  it.each(["text.delta", "reasoning.delta"] as const)("首个 %s 立即按序提交，后续按帧合并", (type) => {
    const { scheduler, flushFrame } = createFakeScheduler();
    const flush = vi.fn();
    const buffer = createGenerationEventBuffer(flush, { scheduler });
    const started = { type: "generation.started", generationId: "g1" } as const;
    const first = { type, generationId: "g1", partId: "p1", delta: "你好" };
    const startedEntry = { cursor: "100-0", event: started };
    const firstEntry = { cursor: "100-1", event: first };
    buffer.enqueue(startedEntry);
    expect(flush).not.toHaveBeenCalled();
    buffer.enqueue(firstEntry);
    expect(scheduler.cancel).toHaveBeenCalledWith(7);
    expect(flush).toHaveBeenCalledExactlyOnceWith([startedEntry, firstEntry]);

    const nextEntries = ["，", "世界"].map((delta, index) => ({
      cursor: `100-${index + 2}`,
      event: { ...first, delta },
    }));
    nextEntries.forEach((entry) => buffer.enqueue(entry));
    expect(scheduler.request).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenCalledOnce();
    flushFrame();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenLastCalledWith(nextEntries);
  });

  it("dispose 会取消尚未执行的帧并丢弃缓冲事件", () => {
    const { scheduler, flushFrame } = createFakeScheduler();
    const flush = vi.fn();
    const buffer = createGenerationEventBuffer(flush, { scheduler });

    buffer.enqueue({
      cursor: "100-0",
      event: { type: "generation.started", generationId: "generation_123" },
    });
    buffer.dispose();
    flushFrame();

    expect(scheduler.cancel).toHaveBeenCalledWith(7);
    expect(flush).not.toHaveBeenCalled();
  });

  it.each([
    "generation.completed",
    "generation.failed",
    "generation.cancelled",
  ] as const)("%s 立即连同已有增量 flush，不被页面清理丢弃", (type) => {
    const { scheduler, flushFrame } = createFakeScheduler();
    const flush = vi.fn();
    const buffer = createGenerationEventBuffer(flush, { scheduler, hasContent: true });
    const delta: GenerationEventDto = {
      type: "text.delta",
      generationId: "g1",
      partId: "p1",
      delta: "最后几个字",
    };
    const terminal: GenerationEventDto = { type, generationId: "g1" };
    const entries = [{ cursor: "100-0", event: delta }, { cursor: "100-1", event: terminal }];
    entries.forEach((entry) => buffer.enqueue(entry));
    expect(scheduler.cancel).toHaveBeenCalledWith(7);
    expect(flush).toHaveBeenCalledExactlyOnceWith(entries);
    buffer.dispose();
    flushFrame();
    expect(flush).toHaveBeenCalledOnce();
  });
});
