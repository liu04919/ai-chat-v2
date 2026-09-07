import type { KnowledgeHit } from "@ai-chat/db";

export const rerankArms = ["vector", "hybrid"] as const;
export type CandidateArm = (typeof rerankArms)[number];
export type Passage = { id: string; text: string };
export type RankedHit = { id: string; score: number; rerankScore?: number };
export type BaselineRow = {
  id: string;
  query: string;
  runs: Record<CandidateArm | "bm25" | "hybrid_rerank", RankedHit[]>;
};
export type RerankRow = {
  id: string;
  arm: CandidateArm;
  hits: RankedHit[];
  tokens: number | null;
  requestId: string | null;
  rerankMs: number;
};

export function validateBaseline(
  queries: Passage[],
  rows: BaselineRow[],
  corpus: Map<string, string>,
) {
  if (
    new Set(queries.map((q) => q.id)).size !== queries.length ||
    rows.length !== queries.length ||
    new Set(rows.map((r) => r.id)).size !== rows.length
  )
    throw new Error("INCOMPLETE_OR_DUPLICATE_BASELINE");
  const queryMap = new Map(queries.map((q) => [q.id, q.text]));
  for (const row of rows) {
    if (queryMap.get(row.id) !== row.query)
      throw new Error("BASELINE_QUERY_MISMATCH");
    for (const arm of [...rerankArms, "bm25", "hybrid_rerank"] as const) {
      const hits = row.runs[arm];
      if (
        hits.length !== 50 ||
        new Set(hits.map((h) => h.id)).size !== 50 ||
        hits.some((h) => !corpus.has(h.id) || !Number.isFinite(h.score))
      )
        throw new Error("INVALID_BASELINE_CANDIDATES");
    }
  }
}

export function candidatesFor(
  row: BaselineRow,
  arm: CandidateArm,
  corpus: Map<string, string>,
): KnowledgeHit[] {
  return row.runs[arm].map((hit) => {
    const content = corpus.get(hit.id);
    if (content === undefined) throw new Error("UNKNOWN_PASSAGE");
    return {
      ...hit,
      content,
      documentId: "duretrieval-corpus",
      originalName: "DuRetrieval original passage",
      page: 1,
      start: 0,
      end: content.length,
    };
  });
}

export function validateRerankRows(rows: RerankRow[], baseline: BaselineRow[]) {
  const known = new Map(baseline.map((r) => [r.id, r]));
  const completed = new Set<string>();
  for (const row of rows) {
    const key = `${row.id}:${row.arm}`;
    const original = known.get(row.id);
    if (!original || !rerankArms.includes(row.arm) || completed.has(key))
      throw new Error("INVALID_RERANK_CHECKPOINT");
    const ids = new Set(original.runs[row.arm].map((h) => h.id));
    if (
      row.hits.length !== ids.size ||
      new Set(row.hits.map((h) => h.id)).size !== ids.size ||
      row.hits.some((h) => !ids.has(h.id) || !Number.isFinite(h.rerankScore)) ||
      !Number.isFinite(row.rerankMs) ||
      row.rerankMs < 0
    )
      throw new Error("RERANK_CHANGED_CANDIDATE_SET");
    completed.add(key);
  }
  return completed;
}
