import {
  conversationShareErrorCodeSchema,
  conversationShareSchema,
  conversationShareStatusResponseSchema,
  deleteConversationShareResponseSchema,
} from "@ai-chat/contracts";

import { getCurrentSession } from "@/server/auth/session";
import {
  ConversationShareServiceError,
  createConversationShareForOwner,
  deleteConversationShareForOwner,
  getConversationShareForOwner,
} from "@/server/conversations/shares";

type RouteContext = { params: Promise<{ conversationId: string }> };
const privateHeaders = { "Cache-Control": "private, no-store" };

function getShareOrigin(): string {
  const baseUrl = process.env.BETTER_AUTH_URL;
  if (!baseUrl) {
    throw new Error("缺少 BETTER_AUTH_URL，无法生成分享链接");
  }
  // 反向代理后的 request.url 可能是容器内部地址，分享链接使用配置的外部站点地址。
  return new URL(baseUrl).origin;
}

function errorResponse(error: unknown): Response | null {
  if (!(error instanceof ConversationShareServiceError)) {
    return null;
  }

  return Response.json(
    { code: conversationShareErrorCodeSchema.parse(error.code) },
    { status: error.status, headers: privateHeaders },
  );
}

export async function GET(_request: Request, { params }: RouteContext) {
  const session = await getCurrentSession();
  if (!session) {
    return Response.json(
      { code: "UNAUTHORIZED" },
      { status: 401, headers: privateHeaders },
    );
  }

  const { conversationId } = await params;
  try {
    const response = await getConversationShareForOwner(
      session.user.id,
      conversationId,
      getShareOrigin(),
    );
    return Response.json(conversationShareStatusResponseSchema.parse(response), {
      headers: privateHeaders,
    });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }
}

export async function POST(_request: Request, { params }: RouteContext) {
  const session = await getCurrentSession();
  if (!session) {
    return Response.json(
      { code: "UNAUTHORIZED" },
      { status: 401, headers: privateHeaders },
    );
  }

  const { conversationId } = await params;
  try {
    const share = await createConversationShareForOwner(
      session.user.id,
      conversationId,
      getShareOrigin(),
    );
    return Response.json(conversationShareSchema.parse(share), {
      status: 201,
      headers: privateHeaders,
    });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const session = await getCurrentSession();
  if (!session) {
    return Response.json(
      { code: "UNAUTHORIZED" },
      { status: 401, headers: privateHeaders },
    );
  }

  const { conversationId } = await params;
  try {
    const response = await deleteConversationShareForOwner(
      session.user.id,
      conversationId,
    );
    return Response.json(deleteConversationShareResponseSchema.parse(response), {
      headers: privateHeaders,
    });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }
}
