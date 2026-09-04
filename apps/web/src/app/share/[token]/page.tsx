import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { conversationShareTokenSchema } from "@ai-chat/contracts";

import { ShareConversation } from "@/components/share/share-conversation";
import { getPublicConversationShare } from "@/server/conversation-shares";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ token: string }> };

async function readShare(params: PageProps["params"]) {
  const { token } = await params;
  if (!conversationShareTokenSchema.safeParse(token).success) {
    return { token, share: null };
  }

  return { token, share: await getPublicConversationShare(token) };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { share } = await readShare(params);

  if (!share) {
    return { title: "分享已失效" };
  }

  return {
    title: `${share.title} · AI Chat`,
    description: "AI Chat 分享对话",
    robots: { index: false, follow: false },
  };
}

export default async function SharePage({ params }: PageProps) {
  const { token, share } = await readShare(params);
  if (!share) notFound();

  return (
    <main className="min-h-svh bg-background">
      <header className="border-b bg-background/95">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <Link className="font-semibold tracking-tight" href="/chat">
            AI Chat
          </Link>
          <span className="text-xs text-muted-foreground">分享对话</span>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-5 py-10 sm:px-8 sm:py-14">
        <h1 className="mb-12 text-2xl font-semibold tracking-tight sm:text-3xl">
          {share.title}
        </h1>
        <ShareConversation snapshot={share.snapshot} token={token} />
      </div>
    </main>
  );
}
