import { redirect } from "next/navigation";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { getCurrentSession } from "@/lib/session";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getCurrentSession();

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="min-h-svh bg-muted/30">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-6">
          <div>
            <p className="font-semibold tracking-tight">AI Chat V2</p>
            <p className="text-xs text-muted-foreground">{session.user.email}</p>
          </div>
          <SignOutButton />
        </div>
      </header>
      {children}
    </div>
  );
}
