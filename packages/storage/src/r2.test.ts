import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createR2ObjectStorage } from "./r2";

const storage = createR2ObjectStorage({
  endpoint: "https://account-id.r2.cloudflarestorage.com",
  bucket: "ai-chat-v2",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
});

describe("R2 object storage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("服务端读取对象字节并传递取消信号", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const send = vi
      .spyOn(S3Client.prototype, "send")
      .mockImplementation(async () => ({
        Body: { transformToByteArray: async () => bytes },
      }));
    const signal = new AbortController().signal;
    await expect(storage.readObject("reference.png", signal)).resolves.toBe(
      bytes,
    );
    const [command, options] = send.mock.calls[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({
      Bucket: "ai-chat-v2",
      Key: "reference.png",
    });
    expect(options).toEqual({ abortSignal: signal });
  });

  it("服务端写入二进制、MIME 和长度，不经过签名 URL", async () => {
    const send = vi
      .spyOn(S3Client.prototype, "send")
      .mockImplementation(async () => ({}));
    const bytes = new Uint8Array([1, 2, 3]);
    const signal = new AbortController().signal;
    await storage.writeObject({
      objectKey: "generated.png",
      data: bytes,
      contentType: "image/png",
      abortSignal: signal,
    });
    const [command, options] = send.mock.calls[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({
      Bucket: "ai-chat-v2",
      Key: "generated.png",
      Body: bytes,
      ContentType: "image/png",
      ContentLength: 3,
    });
    expect(options).toEqual({ abortSignal: signal });
  });

  it("读取缺少响应体及网络异常时明确失败", async () => {
    const send = vi
      .spyOn(S3Client.prototype, "send")
      .mockImplementation(async () => ({}));
    await expect(storage.readObject("missing.png")).rejects.toThrow(
      "缺少响应体",
    );
    send.mockRejectedValueOnce(new Error("network failure"));
    await expect(storage.readObject("failed.png")).rejects.toThrow(
      "network failure",
    );
  });

  it("生成带过期签名的 PUT URL 与必须发送的 Content-Type", async () => {
    const instruction = await storage.createUploadUrl({
      objectKey: "attachments/attachment_example",
      contentType: "image/png",
      expiresInSeconds: 300,
    });
    const url = new URL(instruction.url);

    expect(instruction).toMatchObject({
      method: "PUT",
      headers: { "Content-Type": "image/png" },
    });
    expect(url.pathname).toBe("/ai-chat-v2/attachments/attachment_example");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });

  it("生成短期 GET URL", async () => {
    const signedUrl = await storage.createDownloadUrl(
      "attachments/attachment_example",
      120,
    );
    const url = new URL(signedUrl);

    expect(url.pathname).toBe("/ai-chat-v2/attachments/attachment_example");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });
});
