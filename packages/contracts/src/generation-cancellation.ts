import { z } from "zod";

import { generationStatusSchema } from "./generation";

export const cancelGenerationResponseSchema = z
  .object({
    generation: z
      .object({
        id: z.string().min(1),
        status: generationStatusSchema,
        cancelRequestedAt: z.iso.datetime().nullable(),
      })
      .strict(),
  })
  .strict();

export const cancelGenerationErrorResponseSchema = z
  .object({
    code: z.enum([
      "UNAUTHORIZED",
      "GENERATION_NOT_FOUND",
      "CANCEL_SIGNAL_UNAVAILABLE",
    ]),
  })
  .strict();

export type CancelGenerationResponse = z.infer<
  typeof cancelGenerationResponseSchema
>;
export type CancelGenerationErrorResponse = z.infer<
  typeof cancelGenerationErrorResponseSchema
>;
