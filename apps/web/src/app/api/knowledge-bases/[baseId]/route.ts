import { createKnowledgeRepository } from "@ai-chat/db";
import { knowledgeHttp } from "@/server/knowledge-http";
import { deleteKnowledgeBase } from "@/server/knowledge";
import { getAttachmentObjectStorage } from "@/server/attachment-storage";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ baseId: string }> },
) {
  return knowledgeHttp(async (ownerId) => {
    const { baseId } = await context.params;
    return Response.json(
      await deleteKnowledgeBase(ownerId, baseId, {
        repository: createKnowledgeRepository(),
        storage: getAttachmentObjectStorage(),
      }),
    );
  });
}
