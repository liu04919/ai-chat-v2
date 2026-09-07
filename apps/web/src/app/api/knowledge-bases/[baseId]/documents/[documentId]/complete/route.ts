import { createKnowledgeRepository } from "@ai-chat/db";
import { knowledgeHttp } from "@/server/knowledge-http";
import { completeKnowledgeUpload } from "@/server/knowledge";
import { getAttachmentObjectStorage } from "@/server/attachment-storage";
import { enqueueKnowledge } from "@/server/knowledge-queue";

export async function POST(
  _request: Request,
  context: { params: Promise<{ baseId: string; documentId: string }> },
) {
  return knowledgeHttp(async (ownerId) => {
    const { baseId, documentId } = await context.params;
    return Response.json(
      await completeKnowledgeUpload(ownerId, baseId, documentId, {
        repository: createKnowledgeRepository(),
        storage: getAttachmentObjectStorage(),
        enqueue: enqueueKnowledge,
      }),
    );
  });
}
