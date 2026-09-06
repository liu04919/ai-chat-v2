import { createKnowledgeRepository, type KnowledgeHit } from "@ai-chat/db";
import type { KnowledgeEmbedder } from "./embedding";
import type { KnowledgeReranker } from "./rerank";

export function reciprocalRankFusion(lists: KnowledgeHit[][]) {
  const hits = new Map<string, KnowledgeHit>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((hit, index) => {
      if (seen.has(hit.id)) return;
      seen.add(hit.id);
      const previous = hits.get(hit.id);
      hits.set(hit.id, {
        ...hit,
        score: (previous?.score ?? 0) + 1 / (60 + index + 1),
      });
    });
  }
  return [...hits.values()].sort(
    (a, b) => b.score - a.score || a.id.localeCompare(b.id),
  );
}

export type KnowledgeRetrievalDependencies = {
  repository: Pick<
    ReturnType<typeof createKnowledgeRepository>,
    "requireOwner" | "retrieve"
  >;
  embedder: KnowledgeEmbedder;
};

export async function retrieveKnowledgeCandidates(
  ownerId: string,
  baseId: string,
  query: string,
  dependencies: KnowledgeRetrievalDependencies,
) {
  const { repository, embedder } = dependencies;
  await repository.requireOwner(ownerId, baseId);
  if (!query.trim() || query.length > 2000) throw new Error("INVALID_QUERY");
  const [vector] = await embedder.embed([query]);
  const result = await repository.retrieve(
    ownerId,
    baseId,
    query,
    vector!,
    embedder.model,
  );
  return reciprocalRankFusion([result.semantic, result.lexical]);
}

export async function retrieveKnowledge(
  ownerId: string,
  baseId: string,
  query: string,
  dependencies: KnowledgeRetrievalDependencies & {
    reranker: KnowledgeReranker;
  },
) {
  const candidates = await retrieveKnowledgeCandidates(
    ownerId,
    baseId,
    query,
    dependencies,
  );
  return (await dependencies.reranker.rerank(query, candidates)).hits;
}
