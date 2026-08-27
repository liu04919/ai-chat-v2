import type {
  AttachmentMediaType,
  AttachmentStatusDto,
} from "@ai-chat/contracts";
import { and, eq } from "drizzle-orm";

import { getDatabase } from "./client";
import { attachments } from "./schema/index";

type Database = ReturnType<typeof getDatabase>;

export type AttachmentRecord = {
  id: string;
  ownerId: string;
  objectKey: string;
  originalName: string;
  mediaType: AttachmentMediaType;
  sizeBytes: number;
  status: AttachmentStatusDto;
  readyAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export async function createPendingAttachmentRecord(
  input: {
    id: string;
    ownerId: string;
    objectKey: string;
    originalName: string;
    mediaType: AttachmentMediaType;
    sizeBytes: number;
  },
  database: Database = getDatabase(),
): Promise<AttachmentRecord> {
  const [attachment] = await database
    .insert(attachments)
    .values(input)
    .returning();

  if (!attachment) {
    throw new Error("创建 Attachment 后数据库没有返回记录");
  }

  return attachment;
}

export async function getAttachmentRecordForOwner(
  ownerId: string,
  attachmentId: string,
  database: Database = getDatabase(),
): Promise<AttachmentRecord | null> {
  const [attachment] = await database
    .select()
    .from(attachments)
    .where(
      and(eq(attachments.id, attachmentId), eq(attachments.ownerId, ownerId)),
    )
    .limit(1);

  return attachment ?? null;
}

export async function markAttachmentReady(
  ownerId: string,
  attachmentId: string,
  readyAt: Date,
  database: Database = getDatabase(),
): Promise<AttachmentRecord | null> {
  const [attachment] = await database
    .update(attachments)
    .set({ status: "ready", readyAt, updatedAt: readyAt })
    .where(
      and(
        eq(attachments.id, attachmentId),
        eq(attachments.ownerId, ownerId),
        eq(attachments.status, "pending"),
      ),
    )
    .returning();

  return attachment ?? null;
}
