import { ZodError } from "zod";
import { getCurrentSession } from "@/lib/session";

export async function knowledgeHttp(
  action: (ownerId: string) => Promise<Response>,
) {
  const session = await getCurrentSession();
  if (!session) return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  try {
    return await action(session.user.id);
  } catch (error) {
    const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
    if (
      error instanceof ZodError ||
      error instanceof SyntaxError ||
      code === "INVALID_REQUEST"
    )
      return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    const statuses: Record<string, number> = {
      KNOWLEDGE_NOT_FOUND: 404,
      KNOWLEDGE_UPLOAD_NOT_FOUND: 409,
      KNOWLEDGE_METADATA_MISMATCH: 409,
      KNOWLEDGE_UPLOAD_FAILED: 503,
      KNOWLEDGE_OBJECT_DELETE_FAILED: 503,
    };
    if (statuses[code])
      return Response.json({ code }, { status: statuses[code] });
    console.error("Knowledge API failed");
    return Response.json({ code: "INTERNAL_ERROR" }, { status: 500 });
  }
}
