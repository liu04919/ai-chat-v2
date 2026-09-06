import { z } from "zod";
import {
  retrieveKnowledgeCandidates,
  type KnowledgeRetrievalDependencies,
} from "./retrieve";
import type { KnowledgeReranker } from "./rerank";

export const knowledgeEvaluationSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      query: z.string().trim().min(1).max(2000),
      relevantChunkIds: z.array(z.string().min(1)).min(1),
    }),
  )
  .min(1)
  .max(50)
  .refine(
    (rows) => new Set(rows.map((r) => r.id)).size === rows.length,
    "问题 ID 不可重复",
  );

export function retrievalMetrics(ids: string[], relevantIds: string[]) {
  const relevant = new Set(relevantIds);
  if (!relevant.size) throw new Error("EMPTY_RELEVANCE_LABELS");
  const top = [...new Set(ids)].slice(0, 6);
  const found = top.filter((id) => relevant.has(id)).length;
  const first = top.findIndex((id) => relevant.has(id));
  return {
    recallAt6: found / relevant.size,
    precisionAt6: found / 6,
    mrrAt6: first < 0 ? 0 : 1 / (first + 1),
  };
}

type EvaluationRanking = ReturnType<typeof retrievalMetrics> & {
  ids: string[];
  elapsedMs: number;
};
type EvaluationRow = {
  id: string;
  query: string;
  candidateCount: number;
  candidateRecall: number;
  rrf: EvaluationRanking;
  reranked: EvaluationRanking & {
    totalTokens: number | null;
    requestId: string | null;
  };
};

export async function compareKnowledgeRetrieval(
  ownerId: string,
  baseId: string,
  query: string,
  dependencies: KnowledgeRetrievalDependencies & {
    reranker: KnowledgeReranker;
  },
) {
  const started = performance.now();
  const candidates = await retrieveKnowledgeCandidates(
    ownerId,
    baseId,
    query,
    dependencies,
  );
  const retrievalMs = performance.now() - started;
  const rerankStarted = performance.now();
  const result = await dependencies.reranker.rerank(query, candidates);
  const rerankMs = performance.now() - rerankStarted;
  return {
    candidateCount: candidates.length,
    candidateIds: candidates.map((c) => c.id),
    rrf: { hits: candidates.slice(0, 6), elapsedMs: retrievalMs },
    reranked: {
      hits: result.hits,
      elapsedMs: retrievalMs + rerankMs,
      rerankMs,
      model: dependencies.reranker.model,
      totalTokens: result.totalTokens,
      requestId: result.requestId,
    },
  };
}

export async function evaluateKnowledgeRetrieval(
  ownerId: string,
  baseId: string,
  input: unknown,
  dependencies: KnowledgeRetrievalDependencies & {
    reranker: KnowledgeReranker;
  },
  pricePerMillionTokens?: number,
) {
  const cases = knowledgeEvaluationSchema.parse(input);
  if (
    pricePerMillionTokens !== undefined &&
    (!Number.isFinite(pricePerMillionTokens) || pricePerMillionTokens < 0)
  )
    throw new Error("INVALID_RERANK_PRICE");
  const rows: EvaluationRow[] = [];
  for (const item of cases) {
    // 同一次召回的候选复用给两组，避免 ANN 波动污染精排对照；不重复调用 Embedding。
    const comparison = await compareKnowledgeRetrieval(
      ownerId,
      baseId,
      item.query,
      dependencies,
    );
    const rrfIds = comparison.rrf.hits.map((h) => h.id);
    const rerankedIds = comparison.reranked.hits.map((h) => h.id);
    const relevant = new Set(item.relevantChunkIds);
    rows.push({
      id: item.id,
      query: item.query,
      candidateCount: comparison.candidateCount,
      candidateRecall:
        comparison.candidateIds.filter((id) => relevant.has(id)).length /
        relevant.size,
      rrf: {
        ids: rrfIds,
        elapsedMs: comparison.rrf.elapsedMs,
        ...retrievalMetrics(rrfIds, item.relevantChunkIds),
      },
      reranked: {
        ids: rerankedIds,
        elapsedMs: comparison.reranked.elapsedMs,
        ...retrievalMetrics(rerankedIds, item.relevantChunkIds),
        totalTokens: comparison.reranked.totalTokens,
        requestId: comparison.reranked.requestId,
      },
    });
  }
  const average = (values: number[]) =>
    values.reduce((a, b) => a + b, 0) / values.length;
  const summary = (key: "rrf" | "reranked") => ({
    recallAt6: average(rows.map((r) => r[key].recallAt6)),
    precisionAt6: average(rows.map((r) => r[key].precisionAt6)),
    mrrAt6: average(rows.map((r) => r[key].mrrAt6)),
    meanElapsedMs: average(rows.map((r) => r[key].elapsedMs)),
  });
  const totalTokens = rows.every((r) => r.reranked.totalTokens !== null)
    ? rows.reduce((sum, r) => sum + r.reranked.totalTokens!, 0)
    : null;
  return {
    embeddingModel: dependencies.embedder.model,
    rerankModel: dependencies.reranker.model,
    cases: rows,
    summary: { rrf: summary("rrf"), reranked: summary("reranked") },
    incrementalRerankCost: {
      totalTokens,
      pricePerMillionTokens: pricePerMillionTokens ?? null,
      estimatedCny:
        totalTokens !== null && pricePerMillionTokens !== undefined
          ? (totalTokens * pricePerMillionTokens) / 1_000_000
          : null,
    },
  };
}
