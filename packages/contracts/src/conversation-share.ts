import { z } from "zod";

import { attachmentMediaTypeSchema } from "./attachment";
import { messageSchema } from "./message";

export const conversationShareTokenSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const conversationShareAttachmentSchema = z
  .object({
    id: z.string().min(1),
    originalName: z.string().min(1),
    mediaType: attachmentMediaTypeSchema,
    sizeBytes: z.number().int().positive(),
  })
  .strict();

export const conversationShareSnapshotSchema = z
  .object({
    version: z.literal(1),
    messages: z.array(messageSchema).min(1),
    attachments: z.array(conversationShareAttachmentSchema),
  })
  .strict();

export const conversationShareSchema = z
  .object({
    conversationId: z.string().min(1),
    url: z.url(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const conversationShareStatusResponseSchema = z
  .object({ share: conversationShareSchema.nullable() })
  .strict();

export const deleteConversationShareResponseSchema = z
  .object({ conversationId: z.string().min(1) })
  .strict();

export const conversationShareErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "CONVERSATION_NOT_FOUND",
  "ACTIVE_GENERATION",
  "EMPTY_CONVERSATION",
]);

export type ConversationShareAttachmentDto = z.infer<
  typeof conversationShareAttachmentSchema
>;
export type ConversationShareSnapshotDto = z.infer<
  typeof conversationShareSnapshotSchema
>;
export type ConversationShareDto = z.infer<typeof conversationShareSchema>;
export type ConversationShareStatusResponse = z.infer<
  typeof conversationShareStatusResponseSchema
>;
export type DeleteConversationShareResponse = z.infer<
  typeof deleteConversationShareResponseSchema
>;
export type ConversationShareErrorCode = z.infer<
  typeof conversationShareErrorCodeSchema
>;
