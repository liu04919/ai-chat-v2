import { and, desc, eq, inArray } from "drizzle-orm";

import { getDatabase } from "./client";
import { conversations, generations } from "./schema/index";

type Database = ReturnType<typeof getDatabase>;

const activeGenerationStatuses = ["queued", "running"] as const;

export type ConversationRecord = {
  id: string;
  mode: "chat" | "image";
  title: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ConversationDetailRecord = {
  conversation: ConversationRecord;
  activeGeneration: {
    id: string;
    status: (typeof activeGenerationStatuses)[number];
  } | null;
};

export async function listConversationRecordsForOwner(
  ownerId: string,
  database: Database = getDatabase(),
): Promise<ConversationRecord[]> {
  return database
    .select({
      id: conversations.id,
      mode: conversations.mode,
      title: conversations.title,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(eq(conversations.ownerId, ownerId))
    .orderBy(desc(conversations.updatedAt), desc(conversations.id));
}

export async function getConversationRecordForOwner(
  ownerId: string,
  conversationId: string,
  database: Database = getDatabase(),
): Promise<ConversationDetailRecord | null> {
  const [row] = await database
    .select({
      id: conversations.id,
      mode: conversations.mode,
      title: conversations.title,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
      generationId: generations.id,
      generationStatus: generations.status,
    })
    .from(conversations)
    .leftJoin(
      generations,
      and(
        eq(generations.conversationId, conversations.id),
        inArray(generations.status, activeGenerationStatuses),
      ),
    )
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.ownerId, ownerId),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }

  const activeGeneration =
    row.generationId &&
    (row.generationStatus === "queued" || row.generationStatus === "running")
      ? { id: row.generationId, status: row.generationStatus }
      : null;

  return {
    conversation: {
      id: row.id,
      mode: row.mode,
      title: row.title,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    activeGeneration,
  };
}
