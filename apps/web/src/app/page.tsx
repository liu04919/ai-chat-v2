import { conversationModeSchema } from "@ai-chat/contracts";

import { Badge } from "@/components/ui/badge";

const supportedModes = conversationModeSchema.options.join(" / ");

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl items-center px-6 py-16">
      <section className="w-full space-y-6 rounded-2xl border bg-card p-8 shadow-sm">
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">Workspace foundation</p>
          <h1 className="text-3xl font-semibold tracking-tight">AI Chat V2</h1>
          <p className="max-w-2xl text-muted-foreground">
            Web 与 Worker 拥有独立运行时，领域模型和跨边界协议由 workspace packages 明确隔离。
          </p>
        </div>

        <div className="rounded-lg border bg-muted p-4 text-sm">
          当前 Conversation mode contract：
          <code className="ml-2 font-mono">{supportedModes}</code>
        </div>

        <Badge>基础边界已就绪</Badge>
      </section>
    </main>
  );
}
