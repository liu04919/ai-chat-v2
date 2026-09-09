import {
  knowledgeErrorCodeSchema,
  knowledgeErrorResponseSchema,
  type KnowledgeErrorCode,
} from "@ai-chat/contracts";
import { ZodError } from "zod";
import { getCurrentSession } from "@/server/auth/session";

function errorResponse(code: KnowledgeErrorCode, status: number) {
  return Response.json(knowledgeErrorResponseSchema.parse({ code }), { status });
}

export async function knowledgeHttp(
  action: (ownerId: string) => Promise<Response>,
) {
  const session = await getCurrentSession();
  if (!session) return errorResponse("UNAUTHORIZED", 401);
  try {
    return await action(session.user.id);
  } catch (error) {
    const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
    if (
      error instanceof ZodError ||
      error instanceof SyntaxError ||
      code === "INVALID_REQUEST"
    )
      return errorResponse("INVALID_REQUEST", 400);
    const statuses: Partial<Record<KnowledgeErrorCode, number>> = {
      KNOWLEDGE_NOT_FOUND: 404,
      KNOWLEDGE_UPLOAD_NOT_FOUND: 409,
      KNOWLEDGE_METADATA_MISMATCH: 409,
      KNOWLEDGE_UPLOAD_FAILED: 503,
      KNOWLEDGE_OBJECT_DELETE_FAILED: 503,
    };
    const parsedCode = knowledgeErrorCodeSchema.safeParse(code);
    const status = parsedCode.success ? statuses[parsedCode.data] : undefined;
    if (parsedCode.success && status)
      return errorResponse(parsedCode.data, status);
    console.error("Knowledge API failed");
    return errorResponse("INTERNAL_ERROR", 500);
  }
}
