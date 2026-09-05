import { KNOWLEDGE_DIMENSIONS } from "@ai-chat/contracts";
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const knowledgeStatus = pgEnum("knowledge_status", [
  "pending",
  "processing",
  "ready",
  "failed",
]);
export const knowledgeBases = pgTable(
  "knowledge_bases",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("knowledge_bases_owner_idx").on(t.ownerId)],
);

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: text("id").primaryKey(),
    knowledgeBaseId: text("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull(),
    originalName: text("original_name").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    status: knowledgeStatus("status").notNull().default("pending"),
    embeddingModel: text("embedding_model"),
    chunkCount: integer("chunk_count").notNull().default(0),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("knowledge_documents_base_idx").on(t.knowledgeBaseId),
    uniqueIndex("knowledge_documents_object_key_idx").on(t.objectKey),
  ],
);

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    page: integer("page").notNull(),
    start: integer("start_offset").notNull(),
    end: integer("end_offset").notNull(),
    embedding: vector("embedding", {
      dimensions: KNOWLEDGE_DIMENSIONS,
    }).notNull(),
  },
  (t) => [
    uniqueIndex("knowledge_chunks_document_ordinal_idx").on(
      t.documentId,
      t.ordinal,
    ),
    index("knowledge_chunks_vector_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
    index("knowledge_chunks_bm25_idx")
      .using("bm25", t.content)
      .with({ text_config: "'public.rag_chinese'" }),
  ],
);
