import {
  conversationShareErrorCodeSchema,
  conversationShareSchema,
  conversationShareStatusResponseSchema,
  deleteConversationShareResponseSchema,
} from "@ai-chat/contracts";

import { getCurrentSession } from "@/lib/session";
import {
  ConversationShareServiceError,
  createConversationShareForOwner,
  deleteConversationShareForOwner,
  getConversationShareForOwner,
} from "@/server/conversation-shares";

type RouteContext = { params: Promise<{ conversationId: string }> };
const privateHeaders = { "Cache-Control": "private, no-store" };

function errorResponse(error: unknown): Response | null {
  if (!(error instanceof ConversationShareServiceError)) {
    return null;
  }

  return Response.json(
    { code: conversationShareErrorCodeSchema.parse(error.code) },
    { status: error.status, headers: privateHeaders },
  );
}

export async function GET(request: Request, { params }: RouteContext) {
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
      new URL(request.url).origin,
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

export async function POST(request: Request, { params }: RouteContext) {
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
      new URL(request.url).origin,
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
