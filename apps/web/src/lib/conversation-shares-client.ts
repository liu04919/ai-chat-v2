import {
  conversationShareErrorCodeSchema,
  conversationShareSchema,
  conversationShareStatusResponseSchema,
  deleteConversationShareResponseSchema,
  type ConversationShareDto,
  type ConversationShareStatusResponse,
} from "@ai-chat/contracts";

export class ConversationShareClientError extends Error {
  constructor(readonly code: string) {
    super(
      code === "ACTIVE_GENERATION"
        ? "请等待本轮回复结束后再分享"
        : code === "EMPTY_CONVERSATION"
          ? "当前对话还没有可分享的消息"
          : "分享操作失败，请重试",
    );
  }
}

async function throwShareError(response: Response): Promise<never> {
  const body = await response.json().catch(() => null);
  const parsed = conversationShareErrorCodeSchema.safeParse(body?.code);
  throw new ConversationShareClientError(
    parsed.success ? parsed.data : "UNKNOWN",
  );
}

function shareEndpoint(conversationId: string) {
  return `/api/conversations/${encodeURIComponent(conversationId)}/share`;
}

export async function fetchConversationShare(
  conversationId: string,
): Promise<ConversationShareStatusResponse> {
  const response = await fetch(shareEndpoint(conversationId), {
    cache: "no-store",
  });
  if (!response.ok) return throwShareError(response);
  return conversationShareStatusResponseSchema.parse(await response.json());
}

export async function createConversationShare(
  conversationId: string,
): Promise<ConversationShareDto> {
  const response = await fetch(shareEndpoint(conversationId), {
    method: "POST",
  });
  if (!response.ok) return throwShareError(response);
  return conversationShareSchema.parse(await response.json());
}

export async function deleteConversationShare(
  conversationId: string,
): Promise<void> {
  const response = await fetch(shareEndpoint(conversationId), {
    method: "DELETE",
  });
  if (!response.ok) return throwShareError(response);
  deleteConversationShareResponseSchema.parse(await response.json());
}
