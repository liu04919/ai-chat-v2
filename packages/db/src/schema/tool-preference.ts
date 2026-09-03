import type { McpToolPreferencesDto } from "@ai-chat/contracts";
import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { user } from "./auth";

export const userToolPreferences = pgTable("user_tool_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  mcpToolIds: jsonb("mcp_tool_ids")
    .$type<McpToolPreferencesDto["mcpToolIds"]>()
    .default(sql`'[]'::jsonb`)
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});
