import { z } from "zod";

export const ATTACHMENT_MAX_SIZE_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_UPLOAD_TTL_SECONDS = 5 * 60;

export const attachmentMediaTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
]);

export const attachmentStatusSchema = z.enum(["pending", "ready"]);

export const attachmentSchema = z
  .object({
    id: z.string().min(1),
    originalName: z.string().min(1),
    mediaType: attachmentMediaTypeSchema,
    sizeBytes: z.int().positive().max(ATTACHMENT_MAX_SIZE_BYTES),
    status: attachmentStatusSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const createAttachmentUploadRequestSchema = z
  .object({
    originalName: z.string().trim().min(1).max(255),
    mediaType: attachmentMediaTypeSchema,
    sizeBytes: z.int().positive().max(ATTACHMENT_MAX_SIZE_BYTES),
  })
  .strict();

export const attachmentUploadInstructionSchema = z
  .object({
    method: z.literal("PUT"),
    url: z.url(),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const createAttachmentUploadResponseSchema = z
  .object({
    attachment: attachmentSchema,
    upload: attachmentUploadInstructionSchema,
  })
  .strict();

export const completeAttachmentUploadResponseSchema = z
  .object({
    attachment: attachmentSchema,
  })
  .strict();

export const deleteAttachmentResponseSchema = z
  .object({
    attachmentId: z.string().min(1),
  })
  .strict();

export const attachmentErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "INVALID_REQUEST",
  "ATTACHMENT_NOT_FOUND",
  "ATTACHMENT_UPLOAD_NOT_FOUND",
  "ATTACHMENT_METADATA_MISMATCH",
  "ATTACHMENT_IN_USE",
]);

export const attachmentErrorResponseSchema = z
  .object({
    code: attachmentErrorCodeSchema,
  })
  .strict();

export type AttachmentDto = z.infer<typeof attachmentSchema>;
export type AttachmentMediaType = z.infer<typeof attachmentMediaTypeSchema>;
export type AttachmentStatusDto = z.infer<typeof attachmentStatusSchema>;
export type AttachmentUploadInstruction = z.infer<
  typeof attachmentUploadInstructionSchema
>;
export type CreateAttachmentUploadRequest = z.infer<
  typeof createAttachmentUploadRequestSchema
>;
export type CreateAttachmentUploadResponse = z.infer<
  typeof createAttachmentUploadResponseSchema
>;
export type CompleteAttachmentUploadResponse = z.infer<
  typeof completeAttachmentUploadResponseSchema
>;
export type DeleteAttachmentResponse = z.infer<
  typeof deleteAttachmentResponseSchema
>;
export type AttachmentErrorCode = z.infer<typeof attachmentErrorCodeSchema>;
