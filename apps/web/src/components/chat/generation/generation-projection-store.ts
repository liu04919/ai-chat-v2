"use client";

import type { GenerationEventCursor } from "@ai-chat/contracts";
import type { GenerationEventEntry } from "@ai-chat/event-store";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import {
  createGenerationProjection,
  reduceGenerationEvents,
  type GenerationProjection,
} from "./generation-projection";

// 本地续传缓存的产品上限，不是历史消息上限；淘汰后仍可从 Redis/数据库恢复。
export const MAX_CACHED_GENERATION_PROJECTIONS = 5;

type CachedGenerationProjection = GenerationProjection & {
  lastEventId: GenerationEventCursor | null;
  // 单调递增的访问序号，只在进入会话时更新，不随流式事件更新。
  lastVisited: number;
};

function isNewerCursor(
  cursor: GenerationEventCursor,
  previous: GenerationEventCursor,
) {
  // Redis ID 的两段都是整数，不能按字符串排序，也不能用可能丢精度的 Number。
  const [time, sequence] = cursor.split("-").map(BigInt) as [bigint, bigint];
  const [previousTime, previousSequence] = previous.split("-").map(BigInt) as [
    bigint,
    bigint,
  ];
  return (
    time > previousTime ||
    (time === previousTime && sequence > previousSequence)
  );
}

type GenerationProjectionState = {
  projections: Record<string, CachedGenerationProjection>;
  start(conversationId: string, generationId: string): void;
  apply(
    conversationId: string,
    generationId: string,
    entries: readonly GenerationEventEntry[],
  ): void;
  setReconnecting(conversationId: string, generationId: string): void;
  setConnected(conversationId: string, generationId: string): void;
  setConnectionError(conversationId: string, generationId: string): void;
  clear(conversationId: string): void;
  clearGeneration(conversationId: string, generationId: string): void;
};

export const useGenerationProjectionStore =
  create<GenerationProjectionState>()(
    immer((set) => ({
      projections: {},

      start(conversationId, generationId) {
        set((state) => {
          const cached = state.projections[conversationId];
          const lastVisited = Math.max(
            0,
            ...Object.values(state.projections).map((projection) => projection.lastVisited),
          ) + 1;
          if (cached?.generationId === generationId) {
            cached.lastVisited = lastVisited;
            // 新连接不清空已经应用的内容/游标；真正的终态等历史接管。
            if (!["completed", "failed", "cancelled"].includes(cached.status)) {
              cached.status = "connecting";
            }
          } else {
            state.projections[conversationId] = {
              ...createGenerationProjection(conversationId, generationId),
              lastEventId: null,
              lastVisited,
            };
          }

          const oldest = Object.values(state.projections)
            .filter((projection) => projection.conversationId !== conversationId)
            .sort((left, right) => left.lastVisited - right.lastVisited);
          const excess =
            Object.keys(state.projections).length - MAX_CACHED_GENERATION_PROJECTIONS;
          for (const projection of oldest.slice(0, Math.max(0, excess))) {
            // 内容与游标是一份快照，必须一起淘汰；不取消后台任务。
            delete state.projections[projection.conversationId];
          }
        });
      },

      apply(conversationId, generationId, entries) {
        set((state) => {
          let projection = state.projections[conversationId];

          if (
            !projection ||
            projection.generationId !== generationId ||
            entries.length === 0
          ) {
            return;
          }

          for (const { cursor, event } of entries) {
            if (
              ["completed", "failed", "cancelled", "connection-error"].includes(projection.status)
            ) {
              break;
            }
            if (
              projection.lastEventId &&
              !isNewerCursor(cursor, projection.lastEventId)
            ) {
              continue;
            }
            const next = reduceGenerationEvents(projection, [event]);
            projection = {
              ...next,
              lastVisited: projection.lastVisited,
              // 只有成功应用的事件才能推进游标；同一批次在一次 set 中原子提交。
              lastEventId: next.status === "connection-error"
                ? projection.lastEventId
                : cursor,
            };
            state.projections[conversationId] = projection;
          }
        });
      },

      setReconnecting(conversationId, generationId) {
        set((state) => {
          const projection = state.projections[conversationId];

          if (
            !projection ||
            projection.generationId !== generationId ||
            projection.status === "completed" ||
            projection.status === "failed" ||
            projection.status === "cancelled" ||
            projection.status === "connection-error"
          ) {
            return;
          }

          projection.status = "reconnecting";
        });
      },

      setConnected(conversationId, generationId) {
        set((state) => {
          const projection = state.projections[conversationId];

          if (
            !projection ||
            projection.generationId !== generationId ||
            (projection.status !== "connecting" &&
              projection.status !== "reconnecting")
          ) {
            return;
          }

          projection.status = projection.hasStarted ? "running" : "connecting";
        });
      },

      setConnectionError(conversationId, generationId) {
        set((state) => {
          const projection = state.projections[conversationId];

          if (!projection || projection.generationId !== generationId) {
            return;
          }

          projection.status = "connection-error";
        });
      },

      clear(conversationId) {
        set((state) => {
          delete state.projections[conversationId];
        });
      },

      clearGeneration(conversationId, generationId) {
        set((state) => {
          // 终态同步可能晚于下一轮开始，旧回调不能删除新任务的投影。
          if (state.projections[conversationId]?.generationId !== generationId) {
            return;
          }
          delete state.projections[conversationId];
        });
      },
    })),
  );
