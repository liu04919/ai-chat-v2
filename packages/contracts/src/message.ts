import { z } from "zod";

export const textMessagePartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

export const attachmentMessagePartSchema = z
  .object({
    type: z.literal("attachment"),
    attachmentId: z.string().min(1),
  })
  .strict();

export const messagePartSchema = z.discriminatedUnion("type", [
  textMessagePartSchema,
  attachmentMessagePartSchema,
]);

export const messagePartsSchema = z.array(messagePartSchema).min(1);

export type MessagePartDto = z.infer<typeof messagePartSchema>;
export type MessagePartsDto = z.infer<typeof messagePartsSchema>;
