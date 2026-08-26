import { conversationDetailResponseSchema } from "@ai-chat/contracts";

import { getCurrentSession } from "@/lib/session";
import { getConversationForOwner } from "@/server/conversations";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const session = await getCurrentSession();

  if (!session) {
    return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  }

  const { conversationId } = await params;
  const conversation = await getConversationForOwner(
    session.user.id,
    conversationId,
  );

  if (!conversation) {
    return Response.json({ code: "CONVERSATION_NOT_FOUND" }, { status: 404 });
  }

  return Response.json(conversationDetailResponseSchema.parse(conversation));
}
