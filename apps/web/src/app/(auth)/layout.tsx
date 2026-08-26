import { redirect } from "next/navigation";

import { getCurrentSession } from "@/lib/session";

export default async function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getCurrentSession();

  if (session) {
    redirect("/chat");
  }

  return (
    <main className="grid min-h-svh min-w-0 lg:grid-cols-[1.1fr_0.9fr]">
      <section className="hidden bg-primary p-12 text-primary-foreground lg:flex lg:flex-col lg:justify-between">
        <div className="text-lg font-semibold tracking-tight">AI Chat V2</div>
        <div className="max-w-xl">
          <p className="text-4xl font-semibold leading-tight tracking-tight">
            和 AI 一起，把想法聊清楚。
          </p>
        </div>
        <div aria-hidden="true" />
      </section>

      <section className="flex min-w-0 items-center justify-center px-6 py-12 sm:px-10">
        {children}
      </section>
    </main>
  );
}
