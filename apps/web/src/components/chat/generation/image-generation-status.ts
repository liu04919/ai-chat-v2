import type { ConversationDetailResponse } from "@ai-chat/contracts";
import type { GenerationProjection } from "./generation-projection";

export type ImageGenerationStatus =
  | "queued"
  | "running"
  | "loading"
  | "reconnecting"
  | "stopping"
  | "failed"
  | "cancelled"
  | "connection-error";

export function getImageGenerationStatus({
  activeGeneration,
  latestGeneration,
  projection,
  isSubmitting = false,
  isStopping = false,
}: {
  activeGeneration: ConversationDetailResponse["activeGeneration"];
  latestGeneration: ConversationDetailResponse["latestGeneration"];
  projection: GenerationProjection | null;
  isSubmitting?: boolean;
  isStopping?: boolean;
}): ImageGenerationStatus | null {
  if (isSubmitting) return "queued";
  if (!activeGeneration && latestGeneration?.status === "completed")
    return null;
  // 首次进页或刷新时，失败/停止可能早已结束，不能只靠 SSE 的临时投影。
  if (
    (!activeGeneration || activeGeneration.id === latestGeneration?.id) &&
    (latestGeneration?.status === "failed" ||
      latestGeneration?.status === "cancelled")
  )
    return latestGeneration.status;
  if (
    projection?.status === "failed" ||
    projection?.status === "cancelled" ||
    projection?.status === "connection-error"
  )
    return projection.status;
  if (!activeGeneration) return null;
  if (projection?.status === "completed") return "loading";
  if (isStopping || activeGeneration.cancelRequestedAt) return "stopping";
  if (projection?.status === "reconnecting") return "reconnecting";
  return activeGeneration.status === "running" || projection?.hasStarted
    ? "running"
    : "queued";
}
