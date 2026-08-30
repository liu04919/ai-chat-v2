"use client";

import { MessageParts } from "../messages/message-parts";
import type { GenerationProjection } from "./generation-projection";

const statusMessages = {
  connecting: "正在连接…",
  running: "正在准备回复…",
  reconnecting: "连接中断，正在恢复…",
  completed: "正在同步回复…",
  failed: "回复生成失败，请重新发送。",
  cancelled: "已停止生成。",
  "connection-error": "回复连接异常，请刷新重试。",
} as const;

export function GenerationResponse({
  projection,
}: Readonly<{ projection: GenerationProjection | null }>) {
  if (!projection) {
    return null;
  }

  return (
    <article
      aria-live="polite"
      className="max-w-2xl text-sm leading-7"
      data-generation-status={projection.status}
    >
      {projection.parts.length > 0 ? (
        <MessageParts
          isStreaming={
            projection.status === "connecting" ||
            projection.status === "running" ||
            projection.status === "reconnecting"
          }
          parts={projection.parts}
        />
      ) : null}

      {projection.parts.length === 0 ||
      projection.status === "failed" ||
      projection.status === "cancelled" ||
      projection.status === "connection-error" ||
      projection.status === "reconnecting" ||
      projection.status === "completed" ? (
        <p
          className={
            projection.status === "failed" ||
            projection.status === "connection-error"
              ? "mt-2 text-sm text-destructive"
              : "mt-2 text-sm text-muted-foreground"
          }
          role={
            projection.status === "failed" ||
            projection.status === "connection-error"
              ? "alert"
              : undefined
          }
        >
          {statusMessages[projection.status]}
        </p>
      ) : null}
    </article>
  );
}
