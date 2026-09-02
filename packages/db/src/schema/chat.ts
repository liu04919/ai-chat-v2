import type {
  AssistantMessagePartsDto,
  GenerationToolSelectionDto,
  ReasoningEffortDto,
  UserMessagePartsDto,
} from "@ai-chat/contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { user } from "./auth";

function timestampColumns() {
  return {
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  };
}

export const conversationMode = pgEnum("conversation_mode", ["chat", "image"]);
export const messageRole = pgEnum("message_role", ["user", "assistant"]);
export const generationStatus = pgEnum("generation_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export const reasoningEffort = pgEnum("reasoning_effort", [
  "low",
  "medium",
  "high",
]);

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    mode: conversationMode("mode").notNull(),
    title: text("title").notNull(),
    ...timestampColumns(),
  },
  (table) => [index("conversations_owner_id_idx").on(table.ownerId)],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: messageRole("role").notNull(),
    parts: jsonb("parts")
      .$type<UserMessagePartsDto | AssistantMessagePartsDto>()
      .notNull(),
    sequence: integer("sequence").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("messages_conversation_sequence_unique").on(
      table.conversationId,
      table.sequence,
    ),
    index("messages_conversation_id_idx").on(table.conversationId),
    check("messages_sequence_non_negative", sql`${table.sequence} >= 0`),
  ],
);

export const generations = pgTable(
  "generations",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userMessageId: text("user_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    assistantMessageId: text("assistant_message_id")
      .unique()
      .references(() => messages.id, { onDelete: "set null" }),
    status: generationStatus("status").default("queued").notNull(),
    reasoningEffort: reasoningEffort("reasoning_effort").$type<ReasoningEffortDto>(),
    webSearchEnabled: boolean("web_search_enabled").default(false).notNull(),
    mcpToolIds: jsonb("mcp_tool_ids")
      .$type<GenerationToolSelectionDto["mcpToolIds"]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    errorCode: text("error_code"),
    cancelRequestedAt: timestamp("cancel_requested_at", {
      mode: "date",
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }),
    finishedAt: timestamp("finished_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    index("generations_conversation_id_idx").on(table.conversationId),
    index("generations_user_message_id_idx").on(table.userMessageId),
    uniqueIndex("generations_one_active_per_conversation")
      .on(table.conversationId)
      .where(sql`${table.status} in ('queued', 'running')`),
  ],
);
