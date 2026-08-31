import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_MAX_SIZE_BYTES,
  attachmentSchema,
  createAttachmentUploadRequestSchema,
  createAttachmentUploadResponseSchema,
  deleteAttachmentResponseSchema,
  readAttachmentResponseSchema,
} from "./attachment";

const attachment = {
  id: "attachment_example",
  originalName: "架构图.png",
  mediaType: "image/png",
  sizeBytes: 1024,
  status: "pending",
  createdAt: "2026-08-27T09:00:00.000Z",
  updatedAt: "2026-08-27T09:00:00.000Z",
};

describe("Attachment contracts", () => {
  it("读取响应只包含 ready 附件及有过期时间的下载地址", () => {
    const response = {
      attachment: { ...attachment, status: "ready" },
      download: {
        url: "https://example.com/signed-image",
        expiresAt: "2026-08-31T00:05:00.000Z",
      },
    };
    expect(readAttachmentResponseSchema.parse(response)).toEqual(response);
    expect(
      readAttachmentResponseSchema.safeParse({ ...response, attachment })
        .success,
    ).toBe(false);
    expect(
      readAttachmentResponseSchema.safeParse({
        ...response,
        attachment: { ...response.attachment, objectKey: "secret" },
      }).success,
    ).toBe(false);
  });
  it("接受受支持的上传意图", () => {
    expect(
      createAttachmentUploadRequestSchema.parse({
        originalName: "  架构图.png  ",
        mediaType: "image/png",
        sizeBytes: 1024,
      }),
    ).toEqual({
      originalName: "架构图.png",
      mediaType: "image/png",
      sizeBytes: 1024,
    });
  });

  it("拒绝未知类型、空文件与超限文件", () => {
    expect(() =>
      createAttachmentUploadRequestSchema.parse({
        originalName: "script.svg",
        mediaType: "image/svg+xml",
        sizeBytes: 100,
      }),
    ).toThrow();
    expect(() =>
      createAttachmentUploadRequestSchema.parse({
        originalName: "empty.pdf",
        mediaType: "application/pdf",
        sizeBytes: 0,
      }),
    ).toThrow();
    expect(() =>
      createAttachmentUploadRequestSchema.parse({
        originalName: "large.pdf",
        mediaType: "application/pdf",
        sizeBytes: ATTACHMENT_MAX_SIZE_BYTES + 1,
      }),
    ).toThrow();
  });

  it("上传响应不暴露 objectKey", () => {
    const response = {
      attachment,
      upload: {
        method: "PUT",
        url: "https://example.com/presigned-upload",
        headers: { "Content-Type": "image/png" },
        expiresAt: "2026-08-27T09:05:00.000Z",
      },
    };

    expect(createAttachmentUploadResponseSchema.parse(response)).toEqual(
      response,
    );
    expect(attachmentSchema.parse(attachment)).not.toHaveProperty("objectKey");
  });

  it("删除响应只返回稳定的 Attachment ID", () => {
    expect(
      deleteAttachmentResponseSchema.parse({
        attachmentId: "attachment_example",
      }),
    ).toEqual({ attachmentId: "attachment_example" });
  });
});
