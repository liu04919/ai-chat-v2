"use client";

import {
  generationEventSchema,
  generationEventCursorSchema,
  type GenerationEventDto,
} from "@ai-chat/contracts";
import { useEffect, useEffectEvent } from "react";

import {
  GENERATION_TERMINAL_SIGNAL,
  generationTerminalSignalSchema,
} from "../../../lib/generation-stream";

import { createGenerationEventBuffer } from "./generation-event-buffer";
import { useGenerationProjectionStore } from "./generation-projection-store";

type TerminalGenerationEvent = Extract<
  GenerationEventDto,
  {
    type:
      | "generation.completed"
      | "generation.failed"
      | "generation.cancelled";
  }
>;

export function useGenerationEventStream({
  conversationId,
  generationId,
  enabled,
  onTerminal,
}: {
  conversationId: string;
  generationId: string | null;
  enabled: boolean;
  onTerminal: (event: TerminalGenerationEvent) => void;
}) {
  const onTerminalEvent = useEffectEvent(onTerminal);

  useEffect(() => {
    // 返回会话先读取权威详情；旧 Query 缓存里的 null/running 都不能用于对账。
    if (!enabled) return;
    const store = useGenerationProjectionStore.getState();
    if (!generationId) {
      store.clear(conversationId);
      return;
    }

    store.start(conversationId, generationId);
    const cached = useGenerationProjectionStore.getState().projections[conversationId]!;
    if (
      cached.status === "completed" ||
      cached.status === "failed" ||
      cached.status === "cancelled"
    ) {
      // 曾收到终态但历史同步失败：只重试同步，不从终态游标后打开一条空流。
      onTerminalEvent({ type: `generation.${cached.status}`, generationId });
      return;
    }
    let disposed = false;
    const search = cached.lastEventId
      ? `?after=${encodeURIComponent(cached.lastEventId)}`
      : "";

    const source = new EventSource(
      `/api/generations/${encodeURIComponent(generationId)}/events${search}`,
    );
    // 恢复已有输出的会话时，后续增量继续按帧提交。
    const hasContent = cached.parts.some(
      (part) =>
        (part.type === "text" || part.type === "reasoning") && part.text.length > 0,
    );
    const buffer = createGenerationEventBuffer(
      (entries) => {
        if (disposed) return;
        useGenerationProjectionStore
          .getState()
          .apply(conversationId, generationId, entries);

        const terminalEvent = entries.map((entry) => entry.event).findLast(
          (event): event is TerminalGenerationEvent =>
            event.type === "generation.completed" ||
            event.type === "generation.failed" ||
            event.type === "generation.cancelled",
        );

        if (terminalEvent) {
          closeStream();
          onTerminalEvent(terminalEvent);
        }
      },
      { hasContent },
    );

    function closeStream() {
      if (disposed) return;
      disposed = true;
      source.close();
      buffer.dispose();
    }

    const failStream = () => {
      closeStream();
      store.setConnectionError(conversationId, generationId);
    };

    source.onopen = () => {
      if (disposed) return;
      useGenerationProjectionStore
        .getState()
        .setConnected(conversationId, generationId);
    };

    source.onmessage = (message) => {
      if (disposed) return;
      let body: unknown;

      try {
        body = JSON.parse(message.data);
      } catch {
        failStream();
        return;
      }

      const parsedEvent = generationEventSchema.safeParse(body);
      const cursor = generationEventCursorSchema.safeParse(message.lastEventId);

      if (
        !cursor.success ||
        !parsedEvent.success ||
        parsedEvent.data.generationId !== generationId
      ) {
        failStream();
        return;
      }

      buffer.enqueue({ cursor: cursor.data, event: parsedEvent.data });
    };

    source.addEventListener(GENERATION_TERMINAL_SIGNAL, (message) => {
      if (disposed || !(message instanceof MessageEvent)) return;
      let body: unknown;
      try {
        body = JSON.parse(message.data);
      } catch {
        failStream();
        return;
      }

      const signal = generationTerminalSignalSchema.safeParse(body);
      if (!signal.success || signal.data.generationId !== generationId) {
        failStream();
        return;
      }

      buffer.flushPending();
      store.setTerminal(conversationId, generationId, signal.data.status);
      closeStream();
      onTerminalEvent({ type: `generation.${signal.data.status}`, generationId });
    });

    source.onerror = () => {
      if (disposed) return;
      useGenerationProjectionStore
        .getState()
        .setReconnecting(conversationId, generationId);
    };

    return closeStream;
  }, [conversationId, generationId, enabled]);
}
