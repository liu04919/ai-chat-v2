import { z } from "zod";

export const conversationModeSchema = z.enum(["chat", "image"]);

export type ConversationModeDto = z.infer<typeof conversationModeSchema>;

export const createConversationRequestSchema = z
  .object({
    mode: conversationModeSchema,
  })
  .strict();

export type CreateConversationRequest = z.infer<typeof createConversationRequestSchema>;
