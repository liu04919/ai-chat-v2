import { createKnowledgeRepository } from "@ai-chat/db";
import { knowledgeHttp } from "@/server/knowledge/http";
import { createKnowledgeUpload, toKnowledgeDocument } from "@/server/knowledge/service";
import { getObjectStorage } from "@/server/object-storage";

type Context = { params: Promise<{ baseId: string }> };
export async function GET(_request: Request, context: Context) {
  return knowledgeHttp(async (ownerId) => {
    const { baseId } = await context.params;
    return Response.json({
      documents: (
        await createKnowledgeRepository().listDocuments(ownerId, baseId)
      ).map(toKnowledgeDocument),
    });
  });
}
export async function POST(request: Request, context: Context) {
  return knowledgeHttp(async (ownerId) => {
    const { baseId } = await context.params;
    const repository = createKnowledgeRepository();
    await repository.requireOwner(ownerId, baseId);
    const input: unknown = await request.json();
    return Response.json(
      await createKnowledgeUpload(ownerId, baseId, input, {
        repository,
        storage: getObjectStorage(),
      }),
      { status: 201 },
    );
  });
}
