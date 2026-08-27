import { describe, expect, it } from "vitest";

import { createR2ObjectStorage } from "./r2";

const storage = createR2ObjectStorage({
  endpoint: "https://account-id.r2.cloudflarestorage.com",
  bucket: "ai-chat-v2",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
});

describe("R2 object storage", () => {
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
    expect(url.pathname).toBe(
      "/ai-chat-v2/attachments/attachment_example",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });

  it("生成短期 GET URL", async () => {
    const signedUrl = await storage.createDownloadUrl(
      "attachments/attachment_example",
      120,
    );
    const url = new URL(signedUrl);

    expect(url.pathname).toBe(
      "/ai-chat-v2/attachments/attachment_example",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });
});
