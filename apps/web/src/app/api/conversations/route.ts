import { conversationListResponseSchema } from "@ai-chat/contracts";

import { getCurrentSession } from "@/lib/session";
import { listConversationsForOwner } from "@/server/conversations";

export async function GET() {
  const session = await getCurrentSession();

  if (!session) {
    return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  }

  const conversations = await listConversationsForOwner(session.user.id);
  const response = conversationListResponseSchema.parse({ conversations });

  return Response.json(response);
}
