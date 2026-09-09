import {
  knowledgeErrorResponseSchema,
  type KnowledgeErrorCode,
} from "@ai-chat/contracts";
import { KnowledgeNotFoundError } from "@ai-chat/db";
import { ZodError } from "zod";
import { getCurrentSession } from "@/server/auth/session";
import { KnowledgeServiceError, type KnowledgeServiceErrorCode } from "./errors";

const statuses: Record<KnowledgeServiceErrorCode, number> = {
  INVALID_REQUEST: 400,
  KNOWLEDGE_NOT_FOUND: 404,
  KNOWLEDGE_UPLOAD_NOT_FOUND: 409,
  KNOWLEDGE_METADATA_MISMATCH: 409,
  KNOWLEDGE_UPLOAD_FAILED: 503,
  KNOWLEDGE_OBJECT_DELETE_FAILED: 503,
};

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
    if (error instanceof ZodError || error instanceof SyntaxError)
      return errorResponse("INVALID_REQUEST", 400);
    if (error instanceof KnowledgeNotFoundError)
      return errorResponse(error.code, 404);
    if (error instanceof KnowledgeServiceError)
      return errorResponse(error.code, statuses[error.code]);
    console.error("Knowledge API failed");
    return errorResponse("INTERNAL_ERROR", 500);
  }
}
