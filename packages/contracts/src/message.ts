import { z } from "zod";

const messageBase = {
  id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
} as const;

export const userTextMessagePartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

export const userAttachmentMessagePartSchema = z
  .object({
    type: z.literal("attachment"),
    attachmentId: z.string().min(1),
  })
  .strict();

export const userMessagePartSchema = z.discriminatedUnion("type", [
  userTextMessagePartSchema,
  userAttachmentMessagePartSchema,
]);

export const userMessagePartsSchema = z.array(userMessagePartSchema).min(1);

const assistantPartBase = {
  id: z.string().min(1),
} as const;

export const assistantReasoningMessagePartSchema = z
  .object({
    ...assistantPartBase,
    type: z.literal("reasoning"),
    text: z.string().min(1),
  })
  .strict();

export const assistantTextMessagePartSchema = z
  .object({
    ...assistantPartBase,
    type: z.literal("text"),
    text: z.string().min(1),
  })
  .strict();

export const assistantAttachmentMessagePartSchema = z
  .object({
    ...assistantPartBase,
    type: z.literal("attachment"),
    attachmentId: z.string().min(1),
  })
  .strict();

export const assistantToolCallMessagePartSchema = z
  .object({
    ...assistantPartBase,
    type: z.literal("tool-call"),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    input: z.json(),
  })
  .strict();

export const assistantToolResultMessagePartSchema = z
  .object({
    ...assistantPartBase,
    type: z.literal("tool-result"),
    toolCallId: z.string().min(1),
    output: z.json(),
    isError: z.boolean(),
  })
  .strict();

export const assistantMessagePartSchema = z.discriminatedUnion("type", [
  assistantReasoningMessagePartSchema,
  assistantTextMessagePartSchema,
  assistantAttachmentMessagePartSchema,
  assistantToolCallMessagePartSchema,
  assistantToolResultMessagePartSchema,
]);

export const assistantMessagePartsSchema = z
  .array(assistantMessagePartSchema)
  .min(1)
  .superRefine((parts, context) => {
    const partIds = parts.map((part) => part.id);

    if (new Set(partIds).size !== partIds.length) {
      context.addIssue({
        code: "custom",
        message: "Assistant Message 的 part id 不能重复",
      });
    }
  });

export const assistantToolCallViewPartSchema = z
  .object({
    ...assistantPartBase,
    type: z.literal("tool-call"),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
  })
  .strict();

export const assistantToolResultViewPartSchema = z
  .object({
    ...assistantPartBase,
    type: z.literal("tool-result"),
    toolCallId: z.string().min(1),
    isError: z.boolean(),
  })
  .strict();

export const assistantMessageViewPartSchema = z.discriminatedUnion("type", [
  assistantReasoningMessagePartSchema,
  assistantTextMessagePartSchema,
  assistantAttachmentMessagePartSchema,
  assistantToolCallViewPartSchema,
  assistantToolResultViewPartSchema,
]);

export const assistantMessageViewPartsSchema = z
  .array(assistantMessageViewPartSchema)
  .min(1)
  .superRefine((parts, context) => {
    const partIds = parts.map((part) => part.id);

    if (new Set(partIds).size !== partIds.length) {
      context.addIssue({
        code: "custom",
        message: "Assistant Message View 的 part id 不能重复",
      });
    }
  });

export const messageRoleSchema = z.enum(["user", "assistant"]);

export const userMessageSchema = z
  .object({
    ...messageBase,
    role: z.literal("user"),
    parts: userMessagePartsSchema,
  })
  .strict();

export const assistantMessageSchema = z
  .object({
    ...messageBase,
    role: z.literal("assistant"),
    parts: assistantMessageViewPartsSchema,
  })
  .strict();

export const messageSchema = z.discriminatedUnion("role", [
  userMessageSchema,
  assistantMessageSchema,
]);

export type UserMessagePartDto = z.infer<typeof userMessagePartSchema>;
export type UserMessagePartsDto = z.infer<typeof userMessagePartsSchema>;
export type AssistantMessagePartDto = z.infer<
  typeof assistantMessagePartSchema
>;
export type AssistantMessagePartsDto = z.infer<
  typeof assistantMessagePartsSchema
>;
export type AssistantMessageViewPartDto = z.infer<
  typeof assistantMessageViewPartSchema
>;
export type AssistantMessageViewPartsDto = z.infer<
  typeof assistantMessageViewPartsSchema
>;
export type MessageRoleDto = z.infer<typeof messageRoleSchema>;
export type UserMessageDto = z.infer<typeof userMessageSchema>;
export type AssistantMessageDto = z.infer<typeof assistantMessageSchema>;
export type MessageDto = z.infer<typeof messageSchema>;
