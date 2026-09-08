import { z } from "zod";

export const KNOWLEDGE_DIMENSIONS = 1024;
export const KNOWLEDGE_MAX_BYTES = 10 * 1024 * 1024;
export const KNOWLEDGE_UPLOAD_TTL_SECONDS = 5 * 60;
export const KNOWLEDGE_QUEUE = "knowledge-ingestion";
export const knowledgeMediaTypeSchema = z.enum([
  "text/plain",
  "text/markdown",
  "application/pdf",
]);
export const knowledgeDocumentInputSchema = z.object({
  originalName: z.string().trim().min(1).max(255),
  mediaType: knowledgeMediaTypeSchema,
  sizeBytes: z.number().int().positive().max(KNOWLEDGE_MAX_BYTES),
});
export const knowledgeJobSchema = z
  .object({ documentId: z.string().min(1) })
  .strict();
export type KnowledgeChunk = {
  content: string;
  page: number;
  start: number;
  end: number;
};

export const knowledgeBaseInputSchema = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict();
export const knowledgeBaseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export const knowledgeBaseListSchema = z
  .object({ bases: z.array(knowledgeBaseSchema) })
  .strict();
export const deleteKnowledgeBaseResponseSchema = z
  .object({
    baseId: z.string().min(1),
    cleanupFailed: z.boolean(),
  })
  .strict();
export const knowledgeDocumentSchema = z
  .object({
    id: z.string().min(1),
    originalName: z.string(),
    mediaType: knowledgeMediaTypeSchema,
    sizeBytes: z.number().int(),
    status: z.enum(["uploading", "pending", "processing", "ready", "failed"]),
    chunkCount: z.number().int(),
    errorCode: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export const knowledgeDocumentListSchema = z
  .object({ documents: z.array(knowledgeDocumentSchema) })
  .strict();

export const createKnowledgeUploadResponseSchema = z
  .object({
    document: knowledgeDocumentSchema,
    upload: z
      .object({
        method: z.literal("PUT"),
        url: z.url(),
        headers: z.record(z.string(), z.string()),
        expiresAt: z.iso.datetime(),
      })
      .strict(),
  })
  .strict();

// 引用是当次检索资料的快照，不包含向量、内部评分或对象存储地址。
export const knowledgeSourceSchema = z
  .object({
    // 本轮最多三次检索，每次六条；编号跨调用稳定，不在每次检索时归一。
    number: z.number().int().min(1).max(18),
    chunkId: z.string().min(1),
    documentId: z.string().min(1),
    originalName: z.string(),
    page: z.number().int().positive(),
    content: z.string().min(1),
  })
  .strict();
export const knowledgeSourcesPartSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("knowledge-sources"),
    sources: z.array(knowledgeSourceSchema).max(18),
  })
  .strict();
export type KnowledgeBaseDto = z.infer<typeof knowledgeBaseSchema>;
export type KnowledgeDocumentDto = z.infer<typeof knowledgeDocumentSchema>;
export type KnowledgeSourceDto = z.infer<typeof knowledgeSourceSchema>;
