import type { GenerationStatusDto } from "@ai-chat/contracts";
import { and, eq } from "drizzle-orm";

import { getDatabase } from "./client";
import { conversations, generations } from "./schema/index";

type Database = ReturnType<typeof getDatabase>;

export type GenerationRecord = {
  id: string;
  status: GenerationStatusDto;
};

export async function getGenerationRecordForOwner(
  ownerId: string,
  generationId: string,
  database: Database = getDatabase(),
): Promise<GenerationRecord | null> {
  const [generation] = await database
    .select({
      id: generations.id,
      status: generations.status,
    })
    .from(generations)
    .innerJoin(
      conversations,
      eq(conversations.id, generations.conversationId),
    )
    .where(
      and(
        eq(generations.id, generationId),
        eq(conversations.ownerId, ownerId),
      ),
    )
    .limit(1);

  return generation ?? null;
}
