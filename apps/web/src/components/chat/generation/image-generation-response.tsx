import { ImagePlaceholder } from "../messages/image-placeholder";
import type { ImageGenerationStatus } from "./image-generation-status";

const labels: Record<ImageGenerationStatus, string> = {
  queued: "等待生成…",
  running: "正在生成图片…",
  loading: "正在加载图片…",
  reconnecting: "连接中断，正在恢复…",
  stopping: "正在停止生成…",
  failed: "图片生成失败，请重新发送。",
  cancelled: "已停止生成。",
  "connection-error": "连接异常，请刷新重试。",
};

export function ImageGenerationResponse({
  status,
}: Readonly<{ status: ImageGenerationStatus | null }>) {
  if (!status) return null;
  const animated =
    status === "queued" ||
    status === "running" ||
    status === "loading" ||
    status === "reconnecting";
  return (
    <article
      aria-label="AI 图片回复"
      className="w-full"
      data-generation-status={status}
    >
      {animated ? (
        <ImagePlaceholder label={labels[status]} />
      ) : (
        <p
          className={`py-3 text-sm ${status === "failed" || status === "connection-error" ? "text-destructive" : "text-muted-foreground"}`}
          role={
            status === "failed" || status === "connection-error"
              ? "alert"
              : "status"
          }
        >
          {labels[status]}
        </p>
      )}
    </article>
  );
}
