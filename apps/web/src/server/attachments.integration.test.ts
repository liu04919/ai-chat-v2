import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import {
  closeApplicationDatabase,
  createDatabase,
  getAttachmentRecordForOwner,
  migrateDatabase,
  user,
} from "@ai-chat/db";
import type {
  CreateObjectUploadUrlInput,
  ObjectStorage,
  StoredObjectMetadata,
} from "@ai-chat/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  completeAttachmentUploadForOwner,
  createAttachmentUploadForOwner,
  deleteAttachmentForOwner,
} from "./attachments";

const localEnvironment = fileURLToPath(
  new URL("../../.env.local", import.meta.url),
);

if (existsSync(localEnvironment)) {
  loadEnvFile(localEnvironment);
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error("缺少 TEST_DATABASE_URL");
}

process.env.DATABASE_URL = testDatabaseUrl;

class FakeObjectStorage
  implements Pick<ObjectStorage, "createUploadUrl" | "headObject" | "deleteObject">
{
  readonly objects = new Map<string, StoredObjectMetadata>();

  async createUploadUrl(input: CreateObjectUploadUrlInput) {
    return {
      method: "PUT" as const,
      url: `https://storage.example/${input.objectKey}?signature=test`,
      headers: { "Content-Type": input.contentType },
    };
  }

  async createDownloadUrl(objectKey: string) {
    return `https://storage.example/${objectKey}?signature=download`;
  }

  async headObject(objectKey: string) {
    return this.objects.get(objectKey) ?? null;
  }

  async deleteObject(objectKey: string) {
    this.objects.delete(objectKey);
  }
}

const database = createDatabase(testDatabaseUrl, 1);
const ownerId = `attachment-owner-${randomUUID()}`;
const otherOwnerId = `attachment-other-${randomUUID()}`;

beforeAll(async () => {
  await migrateDatabase({
    databaseUrl: testDatabaseUrl,
    migrationsFolder: fileURLToPath(
      new URL("../../../../packages/db/drizzle", import.meta.url),
    ),
  });
  await database.db.insert(user).values([
    {
      id: ownerId,
      name: "Attachment Owner",
      email: `${ownerId}@example.com`,
    },
    {
      id: otherOwnerId,
      name: "Attachment Other",
      email: `${otherOwnerId}@example.com`,
    },
  ]);
});

afterAll(async () => {
  await database.client`DELETE FROM "user" WHERE id IN (${ownerId}, ${otherOwnerId})`;
  await database.close();
  await closeApplicationDatabase();
});

describe("Attachment upload service", () => {
  it("创建 pending Attachment，并只向 Browser 返回上传所需信息", async () => {
    const storage = new FakeObjectStorage();
    const attachmentId = `attachment-${randomUUID()}`;
    const response = await createAttachmentUploadForOwner(
      ownerId,
      {
        originalName: "diagram.png",
        mediaType: "image/png",
        sizeBytes: 2048,
      },
      { storage, createId: () => attachmentId },
    );

    expect(response).toMatchObject({
      attachment: {
        id: attachmentId,
        status: "pending",
        originalName: "diagram.png",
      },
      upload: {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
      },
    });
    expect(response.attachment).not.toHaveProperty("objectKey");

    const persisted = await getAttachmentRecordForOwner(ownerId, attachmentId);
    expect(persisted?.objectKey).toBe(`attachments/${attachmentId}`);
  });

  it("只有对象大小和 MIME 一致时才确认 ready", async () => {
    const storage = new FakeObjectStorage();
    const attachmentId = `attachment-${randomUUID()}`;
    await createAttachmentUploadForOwner(
      ownerId,
      {
        originalName: "paper.pdf",
        mediaType: "application/pdf",
        sizeBytes: 4096,
      },
      { storage, createId: () => attachmentId },
    );

    await expect(
      completeAttachmentUploadForOwner(ownerId, attachmentId, { storage }),
    ).rejects.toMatchObject({
      code: "ATTACHMENT_UPLOAD_NOT_FOUND",
      status: 409,
    });

    storage.objects.set(`attachments/${attachmentId}`, {
      contentType: "application/pdf",
      sizeBytes: 1,
    });
    await expect(
      completeAttachmentUploadForOwner(ownerId, attachmentId, { storage }),
    ).rejects.toMatchObject({
      code: "ATTACHMENT_METADATA_MISMATCH",
      status: 409,
    });

    storage.objects.set(`attachments/${attachmentId}`, {
      contentType: "application/pdf",
      sizeBytes: 4096,
    });
    await expect(
      completeAttachmentUploadForOwner(ownerId, attachmentId, { storage }),
    ).resolves.toMatchObject({ id: attachmentId, status: "ready" });
  });

  it("其他用户无法确认 Attachment", async () => {
    const storage = new FakeObjectStorage();
    const attachmentId = `attachment-${randomUUID()}`;
    await createAttachmentUploadForOwner(
      ownerId,
      {
        originalName: "private.png",
        mediaType: "image/png",
        sizeBytes: 100,
      },
      { storage, createId: () => attachmentId },
    );

    await expect(
      completeAttachmentUploadForOwner(otherOwnerId, attachmentId, { storage }),
    ).rejects.toMatchObject({
      code: "ATTACHMENT_NOT_FOUND",
      status: 404,
    });
  });

  it("移除草稿 Attachment 时同时删除对象与数据库记录", async () => {
    const storage = new FakeObjectStorage();
    const attachmentId = `attachment-${randomUUID()}`;
    await createAttachmentUploadForOwner(
      ownerId,
      {
        originalName: "remove.png",
        mediaType: "image/png",
        sizeBytes: 512,
      },
      { storage, createId: () => attachmentId },
    );
    storage.objects.set(`attachments/${attachmentId}`, {
      contentType: "image/png",
      sizeBytes: 512,
    });

    await deleteAttachmentForOwner(ownerId, attachmentId, { storage });

    expect(storage.objects.has(`attachments/${attachmentId}`)).toBe(false);
    await expect(
      getAttachmentRecordForOwner(ownerId, attachmentId),
    ).resolves.toBeNull();
  });

  it("其他用户无法删除 Attachment", async () => {
    const storage = new FakeObjectStorage();
    const attachmentId = `attachment-${randomUUID()}`;
    await createAttachmentUploadForOwner(
      ownerId,
      {
        originalName: "owned.pdf",
        mediaType: "application/pdf",
        sizeBytes: 256,
      },
      { storage, createId: () => attachmentId },
    );

    await expect(
      deleteAttachmentForOwner(otherOwnerId, attachmentId, { storage }),
    ).rejects.toMatchObject({
      code: "ATTACHMENT_NOT_FOUND",
      status: 404,
    });
    await expect(
      getAttachmentRecordForOwner(ownerId, attachmentId),
    ).resolves.not.toBeNull();
  });

  it("已经进入 Message 的 Attachment 不允许再删除", async () => {
    const storage = new FakeObjectStorage();
    const attachmentId = `attachment-${randomUUID()}`;
    await createAttachmentUploadForOwner(
      ownerId,
      {
        originalName: "linked.png",
        mediaType: "image/png",
        sizeBytes: 512,
      },
      { storage, createId: () => attachmentId },
    );
    await database.client`
      UPDATE attachments
      SET linked_at = NOW()
      WHERE id = ${attachmentId}
    `;

    await expect(
      deleteAttachmentForOwner(ownerId, attachmentId, { storage }),
    ).rejects.toMatchObject({
      code: "ATTACHMENT_IN_USE",
      status: 409,
    });
    await expect(
      getAttachmentRecordForOwner(ownerId, attachmentId),
    ).resolves.not.toBeNull();
  });
});
