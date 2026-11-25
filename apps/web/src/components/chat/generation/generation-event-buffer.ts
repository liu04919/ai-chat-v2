import type { GenerationEventEntry } from "@ai-chat/event-store";

export type FrameScheduler = {
  request(callback: () => void): number;
  cancel(handle: number): void;
};

export type GenerationEventBuffer = {
  enqueue(entry: GenerationEventEntry): void;
  flushPending(): void;
  dispose(): void;
};

const browserFrameScheduler: FrameScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

export function createGenerationEventBuffer(
  flush: (entries: readonly GenerationEventEntry[]) => void,
  {
    scheduler = browserFrameScheduler,
    hasContent = false,
  }: { scheduler?: FrameScheduler; hasContent?: boolean } = {},
): GenerationEventBuffer {
  let queuedEvents: GenerationEventEntry[] = [];
  let frameHandle: number | null = null;
  let disposed = false;

  const flushFrame = () => {
    frameHandle = null;

    if (disposed || queuedEvents.length === 0) {
      return;
    }

    const events = queuedEvents;
    queuedEvents = [];
    flush(events);
  };

  const flushPending = () => {
    if (frameHandle !== null) scheduler.cancel(frameHandle);
    flushFrame();
  };

  return {
    enqueue(entry) {
      if (disposed) {
        return;
      }

      queuedEvents.push(entry);
      const { event } = entry;
      const isFirstContent =
        !hasContent &&
        (event.type === "text.delta" || event.type === "reasoning.delta");
      if (isFirstContent) hasContent = true;

      if (
        isFirstContent ||
        event.type === "generation.completed" ||
        event.type === "generation.failed" ||
        event.type === "generation.cancelled"
      ) {
        // 首段和终态都带上已排队的事件，按游标顺序一起交付。
        flushPending();
        return;
      }
      frameHandle ??= scheduler.request(flushFrame);
    },

    flushPending,

    dispose() {
      disposed = true;
      queuedEvents = [];

      if (frameHandle !== null) {
        scheduler.cancel(frameHandle);
        frameHandle = null;
      }
    },
  };
}
