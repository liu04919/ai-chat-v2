import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { createR2ObjectStorage } from "./r2";

const localEnvironment = fileURLToPath(
  new URL("../../../apps/web/.env.local", import.meta.url),
);

if (existsSync(localEnvironment)) {
  loadEnvFile(localEnvironment);
}

const requiredEnvironment = [
  "R2_ENDPOINT",
  "R2_BUCKET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
] as const;

for (const name of requiredEnvironment) {
  if (!process.env[name]) {
    throw new Error(`缺少 ${name}，无法执行 R2 integration test`);
  }
}

const storage = createR2ObjectStorage({
  endpoint: process.env.R2_ENDPOINT!,
  bucket: process.env.R2_BUCKET!,
  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
});
const objectKey = `integration-tests/${randomUUID()}`;

afterAll(async () => {
  await storage.deleteObject(objectKey);
});

describe("Cloudflare R2 integration", () => {
  it("使用真实 presigned PUT/GET 上传、核对并读取对象", async () => {
    const body = `R2_STORAGE_ADAPTER_${randomUUID()}`;
    const upload = await storage.createUploadUrl({
      objectKey,
      contentType: "text/plain",
      expiresInSeconds: 120,
    });
    const uploadResponse = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body,
    });

    expect(uploadResponse.ok).toBe(true);
    await expect(storage.headObject(objectKey)).resolves.toEqual({
      contentType: "text/plain",
      sizeBytes: Buffer.byteLength(body),
    });

    const downloadUrl = await storage.createDownloadUrl(objectKey, 120);
    const downloadResponse = await fetch(downloadUrl);

    expect(downloadResponse.ok).toBe(true);
    await expect(downloadResponse.text()).resolves.toBe(body);

    await storage.deleteObject(objectKey);
    await expect(storage.headObject(objectKey)).resolves.toBeNull();
  }, 30_000);
});
