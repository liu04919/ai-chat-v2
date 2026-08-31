import { conversationDetailResponseSchema, conversationPageQuerySchema } from "@ai-chat/contracts";

import { getCurrentSession } from "@/lib/session";
import { getConversationForOwner } from "@/server/conversations";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const session = await getCurrentSession();

  if (!session) {
    return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  }

  const { conversationId } = await params;
  const query = conversationPageQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!query.success) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const conversation = await getConversationForOwner(
    session.user.id,
    conversationId,
    query.data.before,
  );

  if (!conversation) {
    return Response.json({ code: "CONVERSATION_NOT_FOUND" }, { status: 404 });
  }

  return Response.json(conversationDetailResponseSchema.parse(conversation));
}
