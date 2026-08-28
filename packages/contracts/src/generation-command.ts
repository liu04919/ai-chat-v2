import { z } from "zod";

import { conversationModeSchema } from "./conversation";
import { generationStatusSchema, reasoningEffortSchema } from "./generation";
import { messagePartsSchema } from "./message";

export const GENERATION_QUEUE_NAME = "generation";
export const GENERATION_JOB_NAME = "generate";

export const generationTargetSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("new"),
      conversationId: z.string().min(1),
      mode: conversationModeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("existing"),
      conversationId: z.string().min(1),
    })
    .strict(),
]);

export const createGenerationRequestSchema = z
  .object({
    target: generationTargetSchema,
    userMessageId: z.string().min(1),
    parts: messagePartsSchema,
    reasoningEffort: reasoningEffortSchema.nullable(),
  })
  .strict()
  .superRefine((request, context) => {
    const attachmentIds = request.parts.flatMap((part) =>
      part.type === "attachment" ? [part.attachmentId] : [],
    );

    if (new Set(attachmentIds).size !== attachmentIds.length) {
      context.addIssue({
        code: "custom",
        path: ["parts"],
        message: "同一个 Attachment 不能在一条 Message 中重复出现",
      });
    }

    const hasContent = request.parts.some(
      (part) => part.type === "attachment" || part.text.trim().length > 0,
    );

    if (!hasContent) {
      context.addIssue({
        code: "custom",
        path: ["parts"],
        message: "Message 必须包含文本或 Attachment",
      });
    }
  });

export const initialGenerationSchema = z
  .object({
    id: z.string().min(1),
    userMessageId: z.string().min(1),
    status: generationStatusSchema,
    reasoningEffort: reasoningEffortSchema.nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const createGenerationResponseSchema = z
  .object({
    conversationId: z.string().min(1),
    generation: initialGenerationSchema,
  })
  .strict();

const simpleGenerationErrorSchema = z
  .object({
    code: z.enum([
      "UNAUTHORIZED",
      "INVALID_REQUEST",
      "CONVERSATION_NOT_FOUND",
      "MESSAGE_ID_CONFLICT",
      "QUEUE_UNAVAILABLE",
    ]),
  })
  .strict();

const attachmentGenerationErrorSchema = z
  .object({
    code: z.enum([
      "ATTACHMENT_NOT_FOUND",
      "ATTACHMENT_NOT_READY",
      "ATTACHMENT_IN_USE",
      "ATTACHMENT_MODE_MISMATCH",
    ]),
    attachmentId: z.string().min(1),
  })
  .strict();

const activeGenerationErrorSchema = z
  .object({
    code: z.literal("ACTIVE_GENERATION"),
    activeGenerationId: z.string().min(1),
  })
  .strict();

export const generationErrorResponseSchema = z.discriminatedUnion("code", [
  simpleGenerationErrorSchema,
  attachmentGenerationErrorSchema,
  activeGenerationErrorSchema,
]);

export const generationJobPayloadSchema = z
  .object({
    generationId: z.string().min(1),
  })
  .strict();

export type GenerationTargetDto = z.infer<typeof generationTargetSchema>;
export type CreateGenerationRequest = z.infer<
  typeof createGenerationRequestSchema
>;
export type InitialGenerationDto = z.infer<typeof initialGenerationSchema>;
export type CreateGenerationResponse = z.infer<
  typeof createGenerationResponseSchema
>;
export type GenerationErrorResponse = z.infer<
  typeof generationErrorResponseSchema
>;
export type GenerationErrorCode = GenerationErrorResponse["code"];
export type GenerationJobPayload = z.infer<typeof generationJobPayloadSchema>;
