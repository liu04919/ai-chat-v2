import { z } from "zod";

import { createGenerationResponseSchema } from "./generation-command";

export const regenerateGenerationRequestSchema = z
  .object({
    conversationId: z.string().min(1),
    assistantMessageId: z.string().min(1),
  })
  .strict();

export const regenerateGenerationResponseSchema =
  createGenerationResponseSchema;

const simpleRegenerationErrorSchema = z
  .object({
    code: z.enum([
      "UNAUTHORIZED",
      "INVALID_REQUEST",
      "CONVERSATION_NOT_FOUND",
      "ASSISTANT_MESSAGE_NOT_FOUND",
      "REGENERATION_NOT_ALLOWED",
      "QUEUE_UNAVAILABLE",
    ]),
  })
  .strict();

const activeRegenerationErrorSchema = z
  .object({
    code: z.literal("ACTIVE_GENERATION"),
    activeGenerationId: z.string().min(1),
  })
  .strict();

export const regenerationErrorResponseSchema = z.discriminatedUnion("code", [
  simpleRegenerationErrorSchema,
  activeRegenerationErrorSchema,
]);

export type RegenerateGenerationRequest = z.infer<
  typeof regenerateGenerationRequestSchema
>;
export type RegenerateGenerationResponse = z.infer<
  typeof regenerateGenerationResponseSchema
>;
export type RegenerationErrorResponse = z.infer<
  typeof regenerationErrorResponseSchema
>;
