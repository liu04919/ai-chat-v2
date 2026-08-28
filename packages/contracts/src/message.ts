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

export const messageRoleSchema = z.enum(["user", "assistant"]);

export const messageSchema = z
  .object({
    id: z.string().min(1),
    role: messageRoleSchema,
    parts: messagePartsSchema,
    sequence: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export type MessagePartDto = z.infer<typeof messagePartSchema>;
export type MessagePartsDto = z.infer<typeof messagePartsSchema>;
export type MessageRoleDto = z.infer<typeof messageRoleSchema>;
export type MessageDto = z.infer<typeof messageSchema>;
