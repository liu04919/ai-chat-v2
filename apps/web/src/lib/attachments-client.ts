import {
  attachmentErrorResponseSchema,
  completeAttachmentUploadResponseSchema,
  createAttachmentUploadResponseSchema,
  deleteAttachmentResponseSchema,
  type AttachmentErrorCode,
  type AttachmentUploadInstruction,
} from "@ai-chat/contracts";

export class AttachmentClientError extends Error {
  constructor(
    readonly code: AttachmentErrorCode | "UPLOAD_FAILED" | "UNKNOWN",
    message: string,
  ) {
    super(message);
  }
}

const errorMessages: Record<AttachmentClientError["code"], string> = {
  UNAUTHORIZED: "登录状态已失效，请重新登录",
  INVALID_REQUEST: "文件类型或大小不符合要求",
  ATTACHMENT_NOT_FOUND: "附件不存在或已被移除",
  ATTACHMENT_UPLOAD_NOT_FOUND: "没有找到已上传的文件，请重试",
  ATTACHMENT_METADATA_MISMATCH: "上传后的文件信息不一致，请重试",
  ATTACHMENT_IN_USE: "附件已经进入消息，不能再作为草稿移除",
  UPLOAD_FAILED: "文件上传失败，请检查网络后重试",
  UNKNOWN: "附件操作失败，请稍后重试",
};

async function throwAttachmentResponseError(response: Response): Promise<never> {
  const body = await response.json().catch(() => null);
  const parsed = attachmentErrorResponseSchema.safeParse(body);
  const code = parsed.success ? parsed.data.code : "UNKNOWN";

  throw new AttachmentClientError(code, errorMessages[code]);
}

export async function createAttachmentUpload(file: File) {
  const response = await fetch("/api/attachments/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      originalName: file.name,
      mediaType: file.type,
      sizeBytes: file.size,
    }),
  });

  if (!response.ok) {
    await throwAttachmentResponseError(response);
  }

  return createAttachmentUploadResponseSchema.parse(await response.json());
}

export async function uploadAttachmentObject(
  file: File,
  upload: AttachmentUploadInstruction,
): Promise<void> {
  const response = await fetch(upload.url, {
    method: upload.method,
    headers: upload.headers,
    body: file,
  });

  if (!response.ok) {
    throw new AttachmentClientError(
      "UPLOAD_FAILED",
      errorMessages.UPLOAD_FAILED,
    );
  }
}

export async function completeAttachmentUpload(attachmentId: string) {
  const response = await fetch(`/api/attachments/${attachmentId}/complete`, {
    method: "POST",
  });

  if (!response.ok) {
    await throwAttachmentResponseError(response);
  }

  return completeAttachmentUploadResponseSchema.parse(await response.json());
}

export async function deleteAttachment(attachmentId: string): Promise<void> {
  const response = await fetch(`/api/attachments/${attachmentId}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    await throwAttachmentResponseError(response);
  }

  deleteAttachmentResponseSchema.parse(await response.json());
}

export function getAttachmentClientErrorMessage(error: unknown): string {
  return error instanceof AttachmentClientError
    ? error.message
    : errorMessages.UNKNOWN;
}
