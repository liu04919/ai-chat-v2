import { generationEventCursorSchema } from "@ai-chat/contracts";

import { getCurrentSession } from "@/server/auth/session";
import { openGenerationEventStreamForOwner } from "@/server/generations/event-stream";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ generationId: string }> },
) {
  const session = await getCurrentSession();

  if (!session) {
    return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  }

  // 路由切回时由 URL 指定起点；同一 EventSource 自动重连时 Header 是更新的游标。
  const lastEventId = request.headers.get("last-event-id")
    ?? new URL(request.url).searchParams.get("after");
  const cursor = lastEventId !== null
    ? generationEventCursorSchema.safeParse(lastEventId)
    : undefined;

  if (cursor && !cursor.success) {
    return Response.json({ code: "INVALID_EVENT_CURSOR" }, { status: 400 });
  }

  const { generationId } = await params;
  const stream = await openGenerationEventStreamForOwner(
    session.user.id,
    generationId,
    cursor?.data,
  );

  if (!stream) {
    return Response.json({ code: "GENERATION_NOT_FOUND" }, { status: 404 });
  }

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
