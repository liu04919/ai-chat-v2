import { createKnowledgeRepository } from "@ai-chat/db";
import { knowledgeHttp } from "@/server/knowledge-http";
import { deleteKnowledgeDocument } from "@/server/knowledge";
import { getAttachmentObjectStorage } from "@/server/attachment-storage";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ baseId: string; documentId: string }> },
) {
  return knowledgeHttp(async (ownerId) => {
    const { baseId, documentId } = await context.params;
    return Response.json(
      await deleteKnowledgeDocument(ownerId, baseId, documentId, {
        repository: createKnowledgeRepository(),
        storage: getAttachmentObjectStorage(),
      }),
    );
  });
}
