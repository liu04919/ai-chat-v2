import { randomUUID } from "node:crypto";
import {
  KNOWLEDGE_DIMENSIONS,
  knowledgeDocumentInputSchema,
  type KnowledgeChunk,
} from "@ai-chat/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDatabase } from "./client";
import {
  executeKnowledgeSearch,
  knowledgeSearchQueries,
} from "./knowledge-search";
import {
  knowledgeBases,
  knowledgeChunks,
  knowledgeDocuments,
} from "./schema/knowledge";

export function validateKnowledgeVector(vector: number[]) {
  if (
    vector.length !== KNOWLEDGE_DIMENSIONS ||
    vector.some((v) => !Number.isFinite(v)) ||
    !vector.some((v) => v !== 0)
  ) {
    throw new Error("INVALID_EMBEDDING");
  }
}

export type KnowledgeHit = KnowledgeChunk & {
  id: string;
  documentId: string;
  originalName: string;
  score: number;
};

export function createKnowledgeRepository(db = getDatabase()) {
  async function requireOwner(ownerId: string, baseId: string) {
    const [base] = await db
      .select()
      .from(knowledgeBases)
      .where(
        and(eq(knowledgeBases.id, baseId), eq(knowledgeBases.ownerId, ownerId)),
      );
    if (!base) throw new Error("KNOWLEDGE_NOT_FOUND");
    return base;
  }
  return {
    requireOwner,
    async listBases(ownerId: string) {
      return db
        .select()
        .from(knowledgeBases)
        .where(eq(knowledgeBases.ownerId, ownerId))
        .orderBy(desc(knowledgeBases.createdAt));
    },
    async createBase(ownerId: string, name: string) {
      if (!name.trim() || name.trim().length > 100)
        throw new Error("INVALID_NAME");
      const [base] = await db
        .insert(knowledgeBases)
        .values({ id: randomUUID(), ownerId, name: name.trim() })
        .returning();
      return base!;
    },
    async listDocuments(ownerId: string, baseId: string) {
      await requireOwner(ownerId, baseId);
      return db
        .select()
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.knowledgeBaseId, baseId))
        .orderBy(desc(knowledgeDocuments.createdAt));
    },
    async createDocument(
      ownerId: string,
      baseId: string,
      input: {
        originalName: string;
        mediaType: string;
        sizeBytes: number;
        objectKey: string;
        status?: "uploading" | "pending";
      },
    ) {
      await requireOwner(ownerId, baseId);
      const metadata = knowledgeDocumentInputSchema.parse(input);
      const [document] = await db
        .insert(knowledgeDocuments)
        .values({
          ...metadata,
          id: randomUUID(),
          knowledgeBaseId: baseId,
          objectKey: input.objectKey,
          status: input.status ?? "pending",
        })
        .returning();
      return document!;
    },
    async getDocument(ownerId: string, baseId: string, documentId: string) {
      await requireOwner(ownerId, baseId);
      const [document] = await db
        .select()
        .from(knowledgeDocuments)
        .where(
          and(
            eq(knowledgeDocuments.id, documentId),
            eq(knowledgeDocuments.knowledgeBaseId, baseId),
          ),
        );
      if (!document) throw new Error("KNOWLEDGE_NOT_FOUND");
      return document;
    },
    async confirmUpload(ownerId: string, baseId: string, documentId: string) {
      await requireOwner(ownerId, baseId);
      // 条件更新只允许一个完成请求把待上传文件交给入库队列。
      const [document] = await db
        .update(knowledgeDocuments)
        .set({ status: "pending", updatedAt: new Date() })
        .where(
          and(
            eq(knowledgeDocuments.id, documentId),
            eq(knowledgeDocuments.knowledgeBaseId, baseId),
            eq(knowledgeDocuments.status, "uploading"),
          ),
        )
        .returning();
      return document;
    },
    async claim(documentId: string) {
      const [document] = await db
        .update(knowledgeDocuments)
        .set({ status: "processing", updatedAt: new Date() })
        .where(
          and(
            eq(knowledgeDocuments.id, documentId),
            eq(knowledgeDocuments.status, "pending"),
          ),
        )
        .returning();
      return document;
    },
    async fail(
      documentId: string,
      errorCode: string,
      expectedStatus?: "pending",
    ) {
      await db
        .update(knowledgeDocuments)
        .set({ status: "failed", errorCode, updatedAt: new Date() })
        .where(
          and(
            eq(knowledgeDocuments.id, documentId),
            expectedStatus
              ? eq(knowledgeDocuments.status, expectedStatus)
              : sql`${knowledgeDocuments.status} in ('pending', 'processing')`,
          ),
        );
    },
    async publish(
      documentId: string,
      model: string,
      chunks: KnowledgeChunk[],
      vectors: number[][],
    ) {
      if (!chunks.length || chunks.length !== vectors.length)
        throw new Error("INVALID_EMBEDDING_COUNT");
      vectors.forEach(validateKnowledgeVector);
      return db.transaction(async (tx) => {
        const [document] = await tx
          .select()
          .from(knowledgeDocuments)
          .where(eq(knowledgeDocuments.id, documentId))
          .for("update");
        if (!document || document.status !== "processing") return false;
        for (let offset = 0; offset < chunks.length; offset += 50) {
          await tx.insert(knowledgeChunks).values(
            chunks.slice(offset, offset + 50).map((chunk, index) => ({
              ...chunk,
              id: randomUUID(),
              documentId,
              ordinal: offset + index,
              embedding: vectors[offset + index]!,
            })),
          );
        }
        await tx
          .update(knowledgeDocuments)
          .set({
            status: "ready",
            embeddingModel: model,
            chunkCount: chunks.length,
            errorCode: null,
            updatedAt: new Date(),
          })
          .where(eq(knowledgeDocuments.id, documentId));
        return true;
      });
    },
    async deleteDocument(ownerId: string, baseId: string, documentId: string) {
      await requireOwner(ownerId, baseId);
      const [document] = await db
        .delete(knowledgeDocuments)
        .where(
          and(
            eq(knowledgeDocuments.id, documentId),
            eq(knowledgeDocuments.knowledgeBaseId, baseId),
          ),
        )
        .returning();
      return document;
    },
    async retrieve(
      ownerId: string,
      baseId: string,
      query: string,
      vector: number[],
      model: string,
    ) {
      await requireOwner(ownerId, baseId);
      validateKnowledgeVector(vector);
      if (!query.trim() || query.length > 2000)
        throw new Error("INVALID_QUERY");
      const queries = knowledgeSearchQueries(
        ownerId,
        baseId,
        query,
        vector,
        model,
      );
      const { semantic, lexical } = await executeKnowledgeSearch(db, queries);
      return { semantic, lexical };
    },
  };
}
