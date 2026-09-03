import { z } from "zod";

import { activeGenerationSchema, generationStatusSchema } from "./generation";
import { messageSchema } from "./message";

export const conversationModeSchema = z.enum(["chat", "image"]);

export type ConversationModeDto = z.infer<typeof conversationModeSchema>;

export const CONVERSATION_MESSAGE_PAGE_SIZE = 30;
export const conversationMessageCursorSchema = z
  .number().int().min(0).max(2_147_483_647);
export const conversationPageQuerySchema = z
  .object({
    before: z.string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(conversationMessageCursorSchema)
      .optional(),
  })
  .strict();

export const conversationSummarySchema = z
  .object({
    id: z.string().min(1),
    mode: conversationModeSchema,
    title: z.string().min(1),
    pinnedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const conversationListResponseSchema = z
  .object({
    conversations: z.array(conversationSummarySchema),
  })
  .strict();

export const deleteConversationResponseSchema = z
  .object({ conversationId: z.string().min(1) })
  .strict();

export const conversationDetailResponseSchema = z
  .object({
    conversation: conversationSummarySchema,
    activeGeneration: activeGenerationSchema.nullable(),
    latestGeneration: z
      .object({
        id: z.string().min(1),
        status: generationStatusSchema,
      })
      .strict()
      .nullable(),
    messages: z.array(messageSchema),
    nextCursor: conversationMessageCursorSchema.nullable(),
  })
  .strict();

export type ConversationSummaryDto = z.infer<typeof conversationSummarySchema>;
export type DeleteConversationResponse = z.infer<
  typeof deleteConversationResponseSchema
>;
export type ConversationListResponse = z.infer<
  typeof conversationListResponseSchema
>;
export type ConversationDetailResponse = z.infer<
  typeof conversationDetailResponseSchema
>;
