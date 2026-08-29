import type {
  AssistantMessagePartsDto,
  UserMessagePartsDto,
} from "@ai-chat/contracts";
import {
  assistantMessagePartsSchema,
  userMessagePartsSchema,
} from "@ai-chat/contracts";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { getDatabase } from "./client";
import { conversations, generations, messages } from "./schema/index";

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
  messages: Array<
    | {
        id: string;
        role: "user";
        parts: UserMessagePartsDto;
        sequence: number;
        createdAt: Date;
      }
    | {
        id: string;
        role: "assistant";
        parts: AssistantMessagePartsDto;
        sequence: number;
        createdAt: Date;
      }
  >;
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
  const rawMessageRecords = await database
    .select({
      id: messages.id,
      role: messages.role,
      parts: messages.parts,
      sequence: messages.sequence,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, row.id))
    .orderBy(asc(messages.sequence));
  const messageRecords: ConversationDetailRecord["messages"] =
    rawMessageRecords.map((message) =>
      message.role === "user"
        ? {
            ...message,
            role: "user",
            parts: userMessagePartsSchema.parse(message.parts),
          }
        : {
            ...message,
            role: "assistant",
            parts: assistantMessagePartsSchema.parse(message.parts),
          },
    );

  return {
    conversation: {
      id: row.id,
      mode: row.mode,
      title: row.title,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    activeGeneration,
    messages: messageRecords,
  };
}
