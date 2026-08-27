import { randomUUID } from "node:crypto";

import {
  ATTACHMENT_UPLOAD_TTL_SECONDS,
  type AttachmentDto,
  type AttachmentErrorCode,
  type CreateAttachmentUploadRequest,
  type CreateAttachmentUploadResponse,
} from "@ai-chat/contracts";
import {
  createPendingAttachmentRecord,
  deleteAttachmentRecordForOwner,
  getAttachmentRecordForOwner,
  markAttachmentReady,
  type AttachmentRecord,
} from "@ai-chat/db";
import type { ObjectStorage } from "@ai-chat/storage";

import { getAttachmentObjectStorage } from "./attachment-storage";

export class AttachmentServiceError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    readonly status: 404 | 409,
  ) {
    super(code);
  }
}

type AttachmentServiceDependencies = {
  storage?: ObjectStorage;
  createId?: () => string;
  now?: () => Date;
};

function toAttachmentDto(attachment: AttachmentRecord): AttachmentDto {
  return {
    id: attachment.id,
    originalName: attachment.originalName,
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes,
    status: attachment.status,
    createdAt: attachment.createdAt.toISOString(),
    updatedAt: attachment.updatedAt.toISOString(),
  };
}

function normalizeMediaType(mediaType: string | null): string | null {
  return mediaType?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

export async function createAttachmentUploadForOwner(
  ownerId: string,
  input: CreateAttachmentUploadRequest,
  dependencies: AttachmentServiceDependencies = {},
): Promise<CreateAttachmentUploadResponse> {
  const storage = dependencies.storage ?? getAttachmentObjectStorage();
  const attachmentId = (dependencies.createId ?? randomUUID)();
  const now = (dependencies.now ?? (() => new Date()))();
  const objectKey = `attachments/${attachmentId}`;
  const upload = await storage.createUploadUrl({
    objectKey,
    contentType: input.mediaType,
    expiresInSeconds: ATTACHMENT_UPLOAD_TTL_SECONDS,
  });
  const attachment = await createPendingAttachmentRecord({
    id: attachmentId,
    ownerId,
    objectKey,
    originalName: input.originalName,
    mediaType: input.mediaType,
    sizeBytes: input.sizeBytes,
  });

  return {
    attachment: toAttachmentDto(attachment),
    upload: {
      ...upload,
      expiresAt: new Date(
        now.getTime() + ATTACHMENT_UPLOAD_TTL_SECONDS * 1000,
      ).toISOString(),
    },
  };
}

export async function completeAttachmentUploadForOwner(
  ownerId: string,
  attachmentId: string,
  dependencies: AttachmentServiceDependencies = {},
): Promise<AttachmentDto> {
  const attachment = await getAttachmentRecordForOwner(ownerId, attachmentId);

  if (!attachment) {
    throw new AttachmentServiceError("ATTACHMENT_NOT_FOUND", 404);
  }

  if (attachment.status === "ready") {
    return toAttachmentDto(attachment);
  }

  const storage = dependencies.storage ?? getAttachmentObjectStorage();
  const storedObject = await storage.headObject(attachment.objectKey);

  if (!storedObject) {
    throw new AttachmentServiceError("ATTACHMENT_UPLOAD_NOT_FOUND", 409);
  }

  if (
    storedObject.sizeBytes !== attachment.sizeBytes ||
    normalizeMediaType(storedObject.contentType) !== attachment.mediaType
  ) {
    throw new AttachmentServiceError("ATTACHMENT_METADATA_MISMATCH", 409);
  }

  const readyAt = (dependencies.now ?? (() => new Date()))();
  const readyAttachment = await markAttachmentReady(
    ownerId,
    attachmentId,
    readyAt,
  );

  if (readyAttachment) {
    return toAttachmentDto(readyAttachment);
  }

  const concurrentResult = await getAttachmentRecordForOwner(
    ownerId,
    attachmentId,
  );

  if (!concurrentResult) {
    throw new AttachmentServiceError("ATTACHMENT_NOT_FOUND", 404);
  }

  return toAttachmentDto(concurrentResult);
}

export async function deleteAttachmentForOwner(
  ownerId: string,
  attachmentId: string,
  dependencies: AttachmentServiceDependencies = {},
): Promise<void> {
  const attachment = await getAttachmentRecordForOwner(ownerId, attachmentId);

  if (!attachment) {
    throw new AttachmentServiceError("ATTACHMENT_NOT_FOUND", 404);
  }

  const storage = dependencies.storage ?? getAttachmentObjectStorage();
  await storage.deleteObject(attachment.objectKey);
  await deleteAttachmentRecordForOwner(ownerId, attachmentId);
}
