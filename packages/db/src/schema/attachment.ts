import type {
  AttachmentMediaType,
  AttachmentStatusDto,
} from "@ai-chat/contracts";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { user } from "./auth";

const attachmentStatusValues = [
  "pending",
  "ready",
] as const satisfies readonly AttachmentStatusDto[];

export const attachmentStatus = pgEnum(
  "attachment_status",
  attachmentStatusValues,
);

export const attachments = pgTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull(),
    originalName: text("original_name").notNull(),
    mediaType: text("media_type").$type<AttachmentMediaType>().notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    status: attachmentStatus("status").default("pending").notNull(),
    readyAt: timestamp("ready_at", { mode: "date", withTimezone: true }),
    linkedAt: timestamp("linked_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("attachments_owner_id_idx").on(table.ownerId),
    uniqueIndex("attachments_object_key_unique").on(table.objectKey),
    check(
      "attachments_size_bytes_valid",
      sql`${table.sizeBytes} between 1 and 10485760`,
    ),
  ],
);
