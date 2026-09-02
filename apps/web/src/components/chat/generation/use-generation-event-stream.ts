"use client";

import {
  generationEventSchema,
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
  onTerminal,
}: {
  conversationId: string;
  generationId: string | null;
  onTerminal: (event: TerminalGenerationEvent) => void;
}) {
  const onTerminalEvent = useEffectEvent(onTerminal);

  useEffect(() => {
    if (!generationId) {
      return;
    }

    const store = useGenerationProjectionStore.getState();
    store.start(conversationId, generationId);

    const source = new EventSource(
      `/api/generations/${encodeURIComponent(generationId)}/events`,
    );
    const buffer = createGenerationEventBuffer((events) => {
      useGenerationProjectionStore.getState().apply(conversationId, events);

      const terminalEvent = events.findLast(
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
      useGenerationProjectionStore.getState().setConnected(conversationId);
    };

    source.onmessage = (message) => {
      let body: unknown;

      try {
        body = JSON.parse(message.data);
      } catch {
        source.close();
        buffer.dispose();
        useGenerationProjectionStore
          .getState()
          .setConnectionError(conversationId);
        return;
      }

      const parsedEvent = generationEventSchema.safeParse(body);

      if (
        !parsedEvent.success ||
        parsedEvent.data.generationId !== generationId
      ) {
        source.close();
        buffer.dispose();
        useGenerationProjectionStore
          .getState()
          .setConnectionError(conversationId);
        return;
      }

      buffer.enqueue(parsedEvent.data);

      if (
        parsedEvent.data.type === "generation.completed" ||
        parsedEvent.data.type === "generation.failed" ||
        parsedEvent.data.type === "generation.cancelled"
      ) {
        source.close();
      }
    };

    source.onerror = () => {
      useGenerationProjectionStore
        .getState()
        .setReconnecting(conversationId);
    };

    return () => {
      source.close();
      buffer.dispose();
    };
  }, [conversationId, generationId]);
}
