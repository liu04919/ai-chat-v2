import {
  createGenerationResponseSchema,
  generationErrorResponseSchema,
  type CreateGenerationRequest,
  type CreateGenerationResponse,
  type GenerationErrorResponse,
} from "@ai-chat/contracts";

const generationErrorMessages: Record<GenerationErrorResponse["code"], string> = {
  UNAUTHORIZED: "登录状态已失效，请重新登录",
  INVALID_REQUEST: "消息内容无效，请检查后重试",
  CONVERSATION_NOT_FOUND: "对话不存在或已被删除",
  MESSAGE_ID_CONFLICT: "消息状态发生冲突，请刷新后重试",
  QUEUE_UNAVAILABLE: "生成服务暂时不可用，请重试",
  ATTACHMENT_NOT_FOUND: "附件不存在或已被移除",
  ATTACHMENT_NOT_READY: "附件仍在处理中，请稍后重试",
  ATTACHMENT_IN_USE: "附件已经用于其他消息",
  ATTACHMENT_MODE_MISMATCH: "当前模式不支持这个附件",
  ACTIVE_GENERATION: "当前对话仍在生成，请稍后再试",
};

export class GenerationClientError extends Error {
  constructor(readonly response: GenerationErrorResponse | null) {
    super(
      response
        ? generationErrorMessages[response.code]
        : "消息发送失败，请稍后重试",
    );
  }
}

export async function createGeneration(
  request: CreateGenerationRequest,
): Promise<CreateGenerationResponse> {
  const response = await fetch("/api/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsedError = generationErrorResponseSchema.safeParse(body);
    throw new GenerationClientError(
      parsedError.success ? parsedError.data : null,
    );
  }

  return createGenerationResponseSchema.parse(body);
}

export function getGenerationClientErrorMessage(error: unknown): string {
  return error instanceof GenerationClientError
    ? error.message
    : "消息发送失败，请稍后重试";
}
