import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { conversations, generations, messages } from "./chat";

// 一份可替换的派生摘要；原始消息始终留在 messages，不写入浏览器消息 DTO。
export const conversationSummaries = pgTable(
  "conversation_summaries",
  {
    conversationId: text("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    coveredThroughSequence: integer("covered_through_sequence").notNull(),
    coveredThroughMessageId: text("covered_through_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    generationId: text("generation_id").references(() => generations.id, {
      onDelete: "set null",
    }),
    modelId: text("model_id").notNull(),
    tokenizer: text("tokenizer").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    tokenCount: integer("token_count").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check("conversation_summary_positive_version", sql`${table.version} > 0`),
    check(
      "conversation_summary_valid_boundary",
      sql`${table.coveredThroughSequence} >= 0`,
    ),
    check(
      "conversation_summary_nonempty",
      sql`${table.tokenCount} > 0 and length(trim(${table.content})) > 0`,
    ),
  ],
);
