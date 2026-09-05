import { z } from "zod";

export const KNOWLEDGE_DIMENSIONS = 1024;
export const KNOWLEDGE_MAX_BYTES = 10 * 1024 * 1024;
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
