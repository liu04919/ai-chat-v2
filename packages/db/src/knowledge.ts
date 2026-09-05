import { randomUUID } from "node:crypto";
import {
  KNOWLEDGE_DIMENSIONS,
  knowledgeDocumentInputSchema,
  type KnowledgeChunk,
} from "@ai-chat/contracts";
import { and, eq, sql } from "drizzle-orm";
import { getDatabase } from "./client";
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
        .where(eq(knowledgeDocuments.knowledgeBaseId, baseId));
    },
    async createDocument(
      ownerId: string,
      baseId: string,
      input: {
        originalName: string;
        mediaType: string;
        sizeBytes: number;
        objectKey: string;
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
        })
        .returning();
      return document!;
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
    async fail(documentId: string, errorCode: string) {
      await db
        .update(knowledgeDocuments)
        .set({ status: "failed", errorCode, updatedAt: new Date() })
        .where(
          and(
            eq(knowledgeDocuments.id, documentId),
            sql`${knowledgeDocuments.status} in ('pending', 'processing')`,
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
      // 先按账户、知识库和模型筛选，再精确排序；小规模基线不依赖 ANN 的过滤后召回量。
      const eligible = sql`SELECT c.*, d.original_name FROM knowledge_chunks c
        JOIN knowledge_documents d ON d.id = c.document_id JOIN knowledge_bases b ON b.id = d.knowledge_base_id
        WHERE b.id = ${baseId} AND b.owner_id = ${ownerId} AND d.status = 'ready' AND d.embedding_model = ${model}`;
      const fields = sql`id, document_id AS "documentId", original_name AS "originalName", content, page, start_offset AS start, end_offset AS end`;
      const [semantic, lexical] = await Promise.all([
        db.execute<KnowledgeHit>(
          sql`WITH eligible AS MATERIALIZED (${eligible}) SELECT ${fields}, embedding <=> ${JSON.stringify(vector)}::vector AS score FROM eligible ORDER BY score, id LIMIT 20`,
        ),
        db.execute<KnowledgeHit>(
          sql`WITH eligible AS MATERIALIZED (${eligible}), ranked AS (SELECT ${fields}, content <@> to_bm25query(${query}, 'knowledge_chunks_bm25_idx') AS score FROM eligible) SELECT * FROM ranked WHERE score < 0 ORDER BY score, id LIMIT 20`,
        ),
      ]);
      return { semantic: [...semantic], lexical: [...lexical] };
    },
  };
}
