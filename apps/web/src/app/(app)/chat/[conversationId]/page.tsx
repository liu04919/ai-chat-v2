import { notFound, redirect } from "next/navigation";

import { ConversationWorkspace } from "@/components/chat/conversation-workspace";
import { getCurrentSession } from "@/lib/session";
import { getConversationForOwner } from "@/server/conversations";

export default async function ConversationPage({
  params,
}: Readonly<{ params: Promise<{ conversationId: string }> }>) {
  const session = await getCurrentSession();

  if (!session) {
    redirect("/login");
  }

  const { conversationId } = await params;
  const detail = await getConversationForOwner(session.user.id, conversationId);

  if (!detail) {
    notFound();
  }

  return (
    <ConversationWorkspace
      initialDetail={detail}
      key={detail.conversation.id}
    />
  );
}
