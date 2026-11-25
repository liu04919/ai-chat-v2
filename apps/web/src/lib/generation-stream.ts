import { z } from "zod";

export const GENERATION_TERMINAL_SIGNAL = "generation.terminal";

export const generationTerminalStatusSchema = z.enum([
  "completed",
  "failed",
  "cancelled",
]);

export type GenerationTerminalStatus = z.infer<typeof generationTerminalStatusSchema>;

export const generationTerminalSignalSchema = z.object({
  generationId: z.string().min(1),
  status: generationTerminalStatusSchema,
});
