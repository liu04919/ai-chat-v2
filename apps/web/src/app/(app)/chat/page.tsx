import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export default function ChatPage() {
  return (
    <main className="mx-auto flex min-h-[calc(100svh-4rem)] max-w-6xl items-center px-6 py-12">
      <Card className="w-full border-dashed shadow-none">
        <CardHeader>
          <Badge variant="outline">AI Chat V2</Badge>
          <h1 className="text-3xl font-semibold tracking-tight">你的对话工作区</h1>
        </CardHeader>
        <CardContent>
          <p className="max-w-2xl text-muted-foreground">
            这里还没有对话。开始聊天后，你的内容会显示在这里。
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
