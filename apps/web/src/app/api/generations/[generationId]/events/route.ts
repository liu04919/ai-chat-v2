import { generationEventCursorSchema } from "@ai-chat/contracts";

import { getCurrentSession } from "@/lib/session";
import { openGenerationEventStreamForOwner } from "@/server/generation-event-stream";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ generationId: string }> },
) {
  const session = await getCurrentSession();

  if (!session) {
    return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  }

  const lastEventId = request.headers.get("last-event-id");
  const cursor = lastEventId
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
