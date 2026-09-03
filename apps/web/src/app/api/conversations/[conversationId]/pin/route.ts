import { conversationSummarySchema } from "@ai-chat/contracts";

import { getCurrentSession } from "@/lib/session";
import {
  ConversationMutationError,
  pinConversationForOwner,
} from "@/server/conversation-mutations";

async function setPinned(
  pinned: boolean,
  params: Promise<{ conversationId: string }>,
) {
  const session = await getCurrentSession();

  if (!session) {
    return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  }

  const { conversationId } = await params;

  try {
    const conversation = await pinConversationForOwner(
      session.user.id,
      conversationId,
      pinned,
    );
    return Response.json(conversationSummarySchema.parse(conversation));
  } catch (error) {
    if (error instanceof ConversationMutationError) {
      return Response.json(
        { code: "CONVERSATION_NOT_FOUND" },
        { status: error.status },
      );
    }

    throw error;
  }
}

export async function PUT(
  _request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  return setPinned(true, params);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  return setPinned(false, params);
}
