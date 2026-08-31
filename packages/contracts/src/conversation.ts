import { z } from "zod";

import { activeGenerationSchema, generationStatusSchema } from "./generation";
import { messageSchema } from "./message";

export const conversationModeSchema = z.enum(["chat", "image"]);

export type ConversationModeDto = z.infer<typeof conversationModeSchema>;

export const conversationSummarySchema = z
  .object({
    id: z.string().min(1),
    mode: conversationModeSchema,
    title: z.string().min(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const conversationListResponseSchema = z
  .object({
    conversations: z.array(conversationSummarySchema),
  })
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
  })
  .strict();

export type ConversationSummaryDto = z.infer<typeof conversationSummarySchema>;
export type ConversationListResponse = z.infer<
  typeof conversationListResponseSchema
>;
export type ConversationDetailResponse = z.infer<
  typeof conversationDetailResponseSchema
>;
