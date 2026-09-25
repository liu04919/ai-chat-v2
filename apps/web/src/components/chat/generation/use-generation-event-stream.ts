"use client";

import {
  generationEventSchema,
  generationEventCursorSchema,
  type GenerationEventDto,
} from "@ai-chat/contracts";
import { useEffect, useEffectEvent } from "react";

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
    const buffer = createGenerationEventBuffer((entries) => {
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
        onTerminalEvent(terminalEvent);
      }
    });

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
        source.close();
        buffer.dispose();
        useGenerationProjectionStore
          .getState()
          .setConnectionError(conversationId, generationId);
        return;
      }

      const parsedEvent = generationEventSchema.safeParse(body);
      const cursor = generationEventCursorSchema.safeParse(message.lastEventId);

      if (
        !cursor.success ||
        !parsedEvent.success ||
        parsedEvent.data.generationId !== generationId
      ) {
        source.close();
        buffer.dispose();
        useGenerationProjectionStore
          .getState()
          .setConnectionError(conversationId, generationId);
        return;
      }

      buffer.enqueue({ cursor: cursor.data, event: parsedEvent.data });

      if (
        parsedEvent.data.type === "generation.completed" ||
        parsedEvent.data.type === "generation.failed" ||
        parsedEvent.data.type === "generation.cancelled"
      ) {
        source.close();
      }
    };

    source.onerror = () => {
      if (disposed) return;
      useGenerationProjectionStore
        .getState()
        .setReconnecting(conversationId, generationId);
    };

    return () => {
      disposed = true;
      source.close();
      buffer.dispose();
    };
  }, [conversationId, generationId, enabled]);
}
