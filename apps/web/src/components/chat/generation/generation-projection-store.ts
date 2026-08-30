"use client";

import type { GenerationEventDto } from "@ai-chat/contracts";
import { create } from "zustand";

import {
  createGenerationProjection,
  reduceGenerationEvents,
  type GenerationProjection,
} from "./generation-projection";

type GenerationProjectionState = {
  projections: Record<string, GenerationProjection>;
  start(conversationId: string, generationId: string): void;
  apply(conversationId: string, events: readonly GenerationEventDto[]): void;
  setReconnecting(conversationId: string): void;
  setConnected(conversationId: string): void;
  setConnectionError(conversationId: string): void;
  clear(conversationId: string): void;
};

export const useGenerationProjectionStore =
  create<GenerationProjectionState>((set) => ({
    projections: {},

    start(conversationId, generationId) {
      set((state) => ({
        projections: {
          ...state.projections,
          [conversationId]: createGenerationProjection(
            conversationId,
            generationId,
          ),
        },
      }));
    },

    apply(conversationId, events) {
      set((state) => {
        const projection = state.projections[conversationId];

        if (!projection || events.length === 0) {
          return state;
        }

        return {
          projections: {
            ...state.projections,
            [conversationId]: reduceGenerationEvents(projection, events),
          },
        };
      });
    },

    setReconnecting(conversationId) {
      set((state) => {
        const projection = state.projections[conversationId];

        if (
          !projection ||
          projection.status === "completed" ||
          projection.status === "failed" ||
          projection.status === "connection-error"
        ) {
          return state;
        }

        return {
          projections: {
            ...state.projections,
            [conversationId]: {
              ...projection,
              status: "reconnecting",
            },
          },
        };
      });
    },

    setConnected(conversationId) {
      set((state) => {
        const projection = state.projections[conversationId];

        if (
          !projection ||
          (projection.status !== "connecting" &&
            projection.status !== "reconnecting")
        ) {
          return state;
        }

        return {
          projections: {
            ...state.projections,
            [conversationId]: { ...projection, status: "running" },
          },
        };
      });
    },

    setConnectionError(conversationId) {
      set((state) => {
        const projection = state.projections[conversationId];

        if (!projection) {
          return state;
        }

        return {
          projections: {
            ...state.projections,
            [conversationId]: {
              ...projection,
              status: "connection-error",
            },
          },
        };
      });
    },

    clear(conversationId) {
      set((state) => {
        if (!state.projections[conversationId]) {
          return state;
        }

        const projections = { ...state.projections };
        delete projections[conversationId];
        return { projections };
      });
    },
  }));
