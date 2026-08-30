import { z } from "zod";

const generationEventBase = {
  generationId: z.string().min(1),
} as const;

export const generationStartedEventSchema = z
  .object({
    type: z.literal("generation.started"),
    ...generationEventBase,
  })
  .strict();

export const textDeltaEventSchema = z
  .object({
    type: z.literal("text.delta"),
    ...generationEventBase,
    partId: z.string().min(1),
    delta: z.string().min(1),
  })
  .strict();

export const reasoningDeltaEventSchema = z
  .object({
    type: z.literal("reasoning.delta"),
    ...generationEventBase,
    partId: z.string().min(1),
    delta: z.string().min(1),
  })
  .strict();

export const generationCompletedEventSchema = z
  .object({
    type: z.literal("generation.completed"),
    ...generationEventBase,
  })
  .strict();

export const generationFailedEventSchema = z
  .object({
    type: z.literal("generation.failed"),
    ...generationEventBase,
  })
  .strict();

export const generationCancelledEventSchema = z
  .object({
    type: z.literal("generation.cancelled"),
    ...generationEventBase,
  })
  .strict();

export const generationEventSchema = z.discriminatedUnion("type", [
  generationStartedEventSchema,
  textDeltaEventSchema,
  reasoningDeltaEventSchema,
  generationCompletedEventSchema,
  generationFailedEventSchema,
  generationCancelledEventSchema,
]);

export const generationEventCursorSchema = z
  .string()
  .regex(/^\d+-\d+$/, "GenerationEvent cursor 必须是 Redis Stream ID");

export type GenerationEventDto = z.infer<typeof generationEventSchema>;
export type GenerationEventCursor = z.infer<
  typeof generationEventCursorSchema
>;
