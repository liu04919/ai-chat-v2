"use client";

import { MessageParts } from "../messages/message-parts";
import type { GenerationProjection } from "./generation-projection";

const statusMessages = {
  connecting: "正在连接…",
  running: "正在准备回复…",
  reconnecting: "连接中断，正在恢复…",
  completed: "正在同步回复…",
  failed: "回复生成失败，可继续对话或重新发送。",
  cancelled: "已停止生成。",
  "connection-error": "回复连接异常，请刷新重试。",
} as const;

export function GenerationResponse({
  projection,
  failed = false,
}: Readonly<{ projection: GenerationProjection | null; failed?: boolean }>) {
  const status = projection?.status ?? (failed ? "failed" : null);
  if (!status) {
    return null;
  }
  const parts = projection?.parts ?? [];

  return (
    <article
      aria-live="polite"
      className="max-w-2xl text-sm leading-7"
      data-generation-status={status}
    >
      {parts.length > 0 ? (
        <MessageParts
          isStreaming={
            status === "connecting" ||
            status === "running" ||
            status === "reconnecting"
          }
          parts={parts}
        />
      ) : null}

      {parts.length === 0 ||
      status === "failed" ||
      status === "cancelled" ||
      status === "connection-error" ||
      status === "reconnecting" ||
      status === "completed" ? (
        <p
          className={
            status === "failed" ||
            status === "connection-error"
              ? "mt-2 text-sm text-destructive"
              : "mt-2 text-sm text-muted-foreground"
          }
          role={
            status === "failed" ||
            status === "connection-error"
              ? "alert"
              : undefined
          }
        >
          {statusMessages[status]}
        </p>
      ) : null}
    </article>
  );
}
