import { randomUUID } from "node:crypto";
import {
  KNOWLEDGE_UPLOAD_TTL_SECONDS,
  knowledgeBaseSchema,
  knowledgeDocumentInputSchema,
  knowledgeDocumentSchema,
} from "@ai-chat/contracts";
import { createKnowledgeRepository } from "@ai-chat/db";
import type { ObjectStorage } from "@ai-chat/storage";

type Repository = ReturnType<typeof createKnowledgeRepository>;
export type KnowledgeServiceDependencies = {
  repository: Repository;
  storage: Pick<
    ObjectStorage,
    "createUploadUrl" | "headObject" | "deleteObject"
  >;
  enqueue: (documentId: string) => Promise<void>;
};

export function toKnowledgeBase(
  base: Awaited<ReturnType<Repository["createBase"]>>,
) {
  return knowledgeBaseSchema.parse({
    id: base.id,
    name: base.name,
    createdAt: base.createdAt.toISOString(),
  });
}
export function toKnowledgeDocument(
  document: Awaited<ReturnType<Repository["createDocument"]>>,
) {
  const {
    id,
    originalName,
    mediaType,
    sizeBytes,
    status,
    chunkCount,
    errorCode,
    createdAt,
  } = document;
  return knowledgeDocumentSchema.parse({
    id,
    originalName,
    mediaType,
    sizeBytes,
    status,
    chunkCount,
    errorCode,
    createdAt: createdAt.toISOString(),
  });
}

export async function createKnowledgeUpload(
  ownerId: string,
  baseId: string,
  input: unknown,
  dependencies: Pick<KnowledgeServiceDependencies, "repository" | "storage">,
) {
  await dependencies.repository.requireOwner(ownerId, baseId);
  const metadata = knowledgeDocumentInputSchema.parse(input);
  const objectKey = `knowledge/${randomUUID()}`;
  const upload = await dependencies.storage.createUploadUrl({
    objectKey,
    contentType: metadata.mediaType,
    expiresInSeconds: KNOWLEDGE_UPLOAD_TTL_SECONDS,
  });
  const document = await dependencies.repository.createDocument(
    ownerId,
    baseId,
    { ...metadata, objectKey, status: "uploading" },
  );
  return {
    document: toKnowledgeDocument(document),
    upload: {
      ...upload,
      expiresAt: new Date(
        Date.now() + KNOWLEDGE_UPLOAD_TTL_SECONDS * 1000,
      ).toISOString(),
    },
  };
}

export async function completeKnowledgeUpload(
  ownerId: string,
  baseId: string,
  documentId: string,
  dependencies: KnowledgeServiceDependencies,
) {
  const { repository, storage } = dependencies;
  const document = await repository.getDocument(ownerId, baseId, documentId);
  if (document.status !== "uploading") return toKnowledgeDocument(document);

  // 不信任前端的“上传成功”；以 R2 中实际对象的元信息为准。
  const object = await storage.headObject(document.objectKey);
  if (!object) throw new Error("KNOWLEDGE_UPLOAD_NOT_FOUND");
  if (
    object.sizeBytes !== document.sizeBytes ||
    object.contentType?.split(";")[0]?.trim().toLowerCase() !==
      document.mediaType
  )
    throw new Error("KNOWLEDGE_METADATA_MISMATCH");

  const confirmed = await repository.confirmUpload(ownerId, baseId, documentId);
  if (!confirmed) {
    return toKnowledgeDocument(
      await repository.getDocument(ownerId, baseId, documentId),
    );
  }
  try {
    await dependencies.enqueue(documentId);
  } catch {
    await repository.fail(documentId, "ENQUEUE_FAILED", "pending");
    throw new Error("KNOWLEDGE_UPLOAD_FAILED");
  }
  return toKnowledgeDocument(confirmed);
}

export async function deleteKnowledgeDocument(
  ownerId: string,
  baseId: string,
  documentId: string,
  dependencies: Pick<KnowledgeServiceDependencies, "repository" | "storage">,
) {
  const document = await dependencies.repository.deleteDocument(
    ownerId,
    baseId,
    documentId,
  );
  if (!document) throw new Error("KNOWLEDGE_NOT_FOUND");
  try {
    await dependencies.storage.deleteObject(document.objectKey);
  } catch {
    throw new Error("KNOWLEDGE_OBJECT_DELETE_FAILED");
  }
  return { documentId };
}

export async function deleteKnowledgeBase(
  ownerId: string,
  baseId: string,
  dependencies: {
    repository: Repository;
    storage: Pick<ObjectStorage, "deleteObject">;
  },
) {
  const deleted = await dependencies.repository.deleteBase(ownerId, baseId);
  let cleanupFailed = false;
  // 数据库已提交后再清理 R2；一个对象失败不妨碍清理其余对象，也不假装回滚成功。
  for (let offset = 0; offset < deleted.objectKeys.length; offset += 5) {
    const results = await Promise.allSettled(
      deleted.objectKeys
        .slice(offset, offset + 5)
        .map((key) => dependencies.storage.deleteObject(key)),
    );
    if (results.some((result) => result.status === "rejected"))
      cleanupFailed = true;
  }
  return { baseId: deleted.baseId, cleanupFailed };
}
