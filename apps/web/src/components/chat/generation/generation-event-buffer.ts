import type { GenerationEventDto } from "@ai-chat/contracts";

export type FrameScheduler = {
  request(callback: () => void): number;
  cancel(handle: number): void;
};

export type GenerationEventBuffer = {
  enqueue(event: GenerationEventDto): void;
  dispose(): void;
};

const browserFrameScheduler: FrameScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

export function createGenerationEventBuffer(
  flush: (events: readonly GenerationEventDto[]) => void,
  scheduler: FrameScheduler = browserFrameScheduler,
): GenerationEventBuffer {
  let queuedEvents: GenerationEventDto[] = [];
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

  return {
    enqueue(event) {
      if (disposed) {
        return;
      }

      queuedEvents.push(event);
      if (
        event.type === "generation.completed" ||
        event.type === "generation.failed" ||
        event.type === "generation.cancelled"
      ) {
        // 终态不能被路由卸载或详情刷新丢弃；此前的 delta 仍按顺序一起交付。
        if (frameHandle !== null) scheduler.cancel(frameHandle);
        flushFrame();
        return;
      }
      frameHandle ??= scheduler.request(flushFrame);
    },

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
