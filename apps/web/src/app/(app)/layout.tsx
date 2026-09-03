import { redirect } from "next/navigation";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { ConversationSidebar } from "@/components/chat/sidebar/conversation-sidebar";
import { McpToolPreferencesProvider } from "@/components/tools/mcp-tool-preferences-provider";
import { getCurrentSession } from "@/lib/session";
import { listConversationsForOwner } from "@/server/conversations";
import { getMcpToolPreferencesForUser } from "@ai-chat/db";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getCurrentSession();

  if (!session) {
    redirect("/login");
  }

  const [conversations, toolPreferences] = await Promise.all([
    listConversationsForOwner(session.user.id),
    getMcpToolPreferencesForUser(session.user.id),
  ]);
  const displayName = session.user.name || session.user.email;
  const avatarText = displayName.trim().charAt(0).toUpperCase() || "U";

  return (
    <McpToolPreferencesProvider initialPreferences={toolPreferences}>
      <div className="flex h-svh min-h-0 overflow-hidden bg-background">
      <aside className="flex w-72 shrink-0 flex-col border-r bg-muted/45">
        <ConversationSidebar initialConversations={conversations} />

        <footer className="border-t p-3">
          <div className="rounded-2xl border bg-background p-2 shadow-sm">
            <div className="flex min-w-0 items-center gap-3 px-2 py-1.5">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                {avatarText}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{displayName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {session.user.email}
                </p>
              </div>
            </div>
            <div className="mt-2 border-t pt-2">
              <SignOutButton />
            </div>
          </div>
        </footer>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="min-h-0 flex-1">{children}</main>
      </div>
      </div>
    </McpToolPreferencesProvider>
  );
}
