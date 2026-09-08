import type { KnowledgeSourceDto } from "@ai-chat/contracts";
import { createKnowledgeRepository } from "@ai-chat/db";
import { createKnowledgeEmbedder } from "./embedding";
import { createKnowledgeReranker } from "./rerank";
import { retrieveKnowledge } from "./retrieve";

export type ChatKnowledgeRetriever = (input: {
  ownerId: string;
  baseId: string;
  query: string;
  signal: AbortSignal;
}) => Promise<Omit<KnowledgeSourceDto, "number">[]>;

// 聊天工具与检索底座之间的薄适配；不决定何时检索，也不修改模型请求。
export const retrieveChatKnowledge: ChatKnowledgeRetriever = async (input) => {
  const hits = await retrieveKnowledge(input.ownerId, input.baseId, input.query, {
    repository: createKnowledgeRepository(),
    embedder: createKnowledgeEmbedder(),
    reranker: createKnowledgeReranker(),
    signal: input.signal,
  });
  return hits.map((hit) => ({
    chunkId: hit.id,
    documentId: hit.documentId,
    originalName: hit.originalName,
    page: hit.page,
    content: hit.content,
  }));
};
