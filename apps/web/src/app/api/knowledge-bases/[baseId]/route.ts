import { deleteKnowledgeBaseResponseSchema } from "@ai-chat/contracts";
import { createKnowledgeRepository } from "@ai-chat/db";
import { knowledgeHttp } from "@/server/knowledge/http";
import { deleteKnowledgeBase } from "@/server/knowledge/service";
import { getObjectStorage } from "@/server/object-storage";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ baseId: string }> },
) {
  return knowledgeHttp(async (ownerId) => {
    const { baseId } = await context.params;
    const response = await deleteKnowledgeBase(ownerId, baseId, {
      repository: createKnowledgeRepository(),
      storage: getObjectStorage(),
    });
    return Response.json(deleteKnowledgeBaseResponseSchema.parse(response));
  });
}
