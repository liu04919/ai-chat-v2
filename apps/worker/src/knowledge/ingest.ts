import { createKnowledgeRepository } from "@ai-chat/db";
import type { ObjectStorage } from "@ai-chat/storage";
import type { KnowledgeEmbedder } from "./embedding";
import { parseKnowledgeFile } from "./parse";

export async function ingestKnowledge(
  documentId: string,
  dependencies: {
    repository: ReturnType<typeof createKnowledgeRepository>;
    storage: Pick<ObjectStorage, "readObject">;
    createEmbedder(): KnowledgeEmbedder;
  },
) {
  const { repository, storage } = dependencies;
  const document = await repository.claim(documentId);
  if (!document) return;
  try {
    const bytes = await storage.readObject(
      document.objectKey,
      AbortSignal.timeout(60_000),
    );
    if (bytes.byteLength !== document.sizeBytes)
      throw new Error("FILE_SIZE_MISMATCH");
    const chunks = await parseKnowledgeFile(bytes, document.mediaType);
    const embedder = dependencies.createEmbedder();
    const vectors = await embedder.embed(chunks.map((chunk) => chunk.content));
    await repository.publish(documentId, embedder.model, chunks, vectors);
  } catch {
    // 原始上游异常可能包含请求内容或凭证；持久化和队列只保留固定错误码。
    await repository.fail(documentId, "INGESTION_FAILED");
    throw new Error("INGESTION_FAILED");
  }
}
