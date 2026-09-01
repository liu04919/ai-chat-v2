import { z } from "zod";

export const generationStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export type GenerationStatusDto = z.infer<typeof generationStatusSchema>;

export const reasoningEffortSchema = z.enum(["low", "medium", "high"]);

export type ReasoningEffortDto = z.infer<typeof reasoningEffortSchema>;

export const activeGenerationSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["queued", "running"]),
    cancelRequestedAt: z.iso.datetime().nullable(),
    replacesAssistantMessageId: z.string().min(1).nullable(),
  })
  .strict();

export const chatRuntimeStateSchema = z
  .object({
    activeGeneration: activeGenerationSchema.nullable(),
  })
  .strict();

export type ChatRuntimeStateDto = z.infer<typeof chatRuntimeStateSchema>;
