import type { ConversationDetailResponse } from "@ai-chat/contracts";
import type { GenerationProjection } from "./generation-projection";

/** 持久化历史接管已结束的失败回答，投影只负责尚未同步的内容。 */
export function getChatGenerationDisplay({
  activeGeneration,
  latestGeneration,
  projection,
  isSubmitting,
}: {
  activeGeneration: ConversationDetailResponse["activeGeneration"];
  latestGeneration: ConversationDetailResponse["latestGeneration"];
  projection: GenerationProjection | null;
  isSubmitting: boolean;
}): { projection: GenerationProjection | null; failed: boolean } {
  // 乐观插入新问题期间，不把上一轮的红色提示挂到新问题下面。
  // 请求失败后 pending 结束，仍由未变的 latestGeneration 恢复提示。
  if (isSubmitting) return { projection: null, failed: false };

  if (!activeGeneration && latestGeneration?.status === "failed") {
    // 此时详情中已包含失败前保存的消息，不再重复显示流式投影。
    return { projection: null, failed: true };
  }

  const generationId = activeGeneration?.id ?? latestGeneration?.id;
  const current = projection?.generationId === generationId ? projection : null;
  const visible =
    activeGeneration !== null ||
    current?.status === "cancelled" ||
    current?.status === "connection-error";

  return { projection: visible ? current : null, failed: false };
}
