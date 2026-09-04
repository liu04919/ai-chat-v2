import type { ConversationShareSnapshotDto } from "@ai-chat/contracts";
import { jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { conversations } from "./chat";

export const conversationShares = pgTable(
  "conversation_shares",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    title: text("title").notNull(),
    snapshot: jsonb("snapshot").$type<ConversationShareSnapshotDto>().notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("conversation_shares_conversation_id_unique").on(
      table.conversationId,
    ),
    uniqueIndex("conversation_shares_token_unique").on(table.token),
  ],
);
