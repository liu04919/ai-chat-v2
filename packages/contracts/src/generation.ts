import { z } from "zod";

export const generationStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export type GenerationStatusDto = z.infer<typeof generationStatusSchema>;

export const activeGenerationSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["queued", "running"]),
  })
  .strict();

export const chatRuntimeStateSchema = z
  .object({
    activeGeneration: activeGenerationSchema.nullable(),
  })
  .strict();

export type ChatRuntimeStateDto = z.infer<typeof chatRuntimeStateSchema>;
