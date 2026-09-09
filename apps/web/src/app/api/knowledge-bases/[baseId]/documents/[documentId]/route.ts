import { deleteKnowledgeDocumentResponseSchema } from "@ai-chat/contracts";
import { createKnowledgeRepository } from "@ai-chat/db";
import { knowledgeHttp } from "@/server/knowledge/http";
import { deleteKnowledgeDocument } from "@/server/knowledge/service";
import { getObjectStorage } from "@/server/object-storage";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ baseId: string; documentId: string }> },
) {
  return knowledgeHttp(async (ownerId) => {
    const { baseId, documentId } = await context.params;
    const response = await deleteKnowledgeDocument(ownerId, baseId, documentId, {
      repository: createKnowledgeRepository(),
      storage: getObjectStorage(),
    });
    return Response.json(deleteKnowledgeDocumentResponseSchema.parse(response));
  });
}
