import { knowledgeBaseInputSchema } from "@ai-chat/contracts";
import { createKnowledgeRepository } from "@ai-chat/db";
import { knowledgeHttp } from "@/server/knowledge/http";
import { toKnowledgeBase } from "@/server/knowledge/service";

export async function GET() {
  return knowledgeHttp(async (ownerId) =>
    Response.json({
      bases: (await createKnowledgeRepository().listBases(ownerId)).map(
        toKnowledgeBase,
      ),
    }),
  );
}
export async function POST(request: Request) {
  return knowledgeHttp(async (ownerId) => {
    const { name } = knowledgeBaseInputSchema.parse(await request.json());
    return Response.json(
      toKnowledgeBase(
        await createKnowledgeRepository().createBase(ownerId, name),
      ),
      { status: 201 },
    );
  });
}
