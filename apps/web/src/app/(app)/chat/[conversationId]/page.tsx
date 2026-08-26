import { ImageIcon, MessageSquareText } from "lucide-react";
import { notFound, redirect } from "next/navigation";

import { ChatComposer } from "@/components/chat/chat-composer";
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

  const { conversation } = detail;
  const ModeIcon = conversation.mode === "image" ? ImageIcon : MessageSquareText;

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b px-8">
        <ModeIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        <h1 className="truncate font-medium">{conversation.title}</h1>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center px-5 text-center">
        <p className="text-lg text-muted-foreground">
          {conversation.mode === "chat" ? "继续这段对话" : "继续你的创作"}
        </p>
      </div>

      <div className="mx-auto w-full max-w-3xl shrink-0 px-5 pb-6">
        <ChatComposer mode={conversation.mode} />
      </div>
    </section>
  );
}
