import { ImageIcon, MessageSquareText } from "lucide-react";
import { notFound, redirect } from "next/navigation";

import { ChatComposer } from "@/components/chat/composer/chat-composer";
import { MessageParts } from "@/components/chat/messages/message-parts";
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

      <div className="min-h-0 flex-1 overflow-y-auto px-5">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 py-8">
          {detail.messages.map((message) => (
            <article
              className={
                message.role === "user"
                  ? "ml-auto max-w-2xl rounded-3xl bg-muted px-5 py-3 text-sm shadow-sm"
                  : "max-w-2xl text-sm leading-7"
              }
              key={message.id}
            >
              <MessageParts parts={message.parts} />
            </article>
          ))}

          {detail.activeGeneration ? (
            <p className="text-sm text-muted-foreground">正在准备回复…</p>
          ) : null}
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl shrink-0 px-5 pb-6">
        <ChatComposer mode={conversation.mode} />
      </div>
    </section>
  );
}
