import { describe, expect, it } from "vitest";
import {
  candidatesFor,
  validateBaseline,
  validateRerankRows,
  type BaselineRow,
  type RerankRow,
} from "./rerank-ablation-support";

function fixture() {
  const hits = Array.from({ length: 50 }, (_, i) => ({
    id: String(i),
    score: i,
  }));
  const row: BaselineRow = {
    id: "q1",
    query: "问题",
    runs: { vector: hits, bm25: hits, hybrid: hits, hybrid_rerank: hits },
  };
  const corpus = new Map(hits.map((h) => [h.id, `原文 ${h.id}`]));
  const result: RerankRow = {
    id: "q1",
    arm: "vector",
    hits: [...hits].reverse().map((h) => ({ ...h, rerankScore: 0.9 })),
    tokens: 10,
    requestId: "test",
    rerankMs: 15,
  };
  return { row, corpus, result, queries: [{ id: "q1", text: "问题" }] };
}

describe("补测候选和断点校验", () => {
  it("固定原候选和原文，精排只能改变顺序", () => {
    const { row, corpus, result, queries } = fixture();
    validateBaseline(queries, [row], corpus);
    expect(candidatesFor(row, "vector", corpus).map((c) => c.id)).toEqual(
      row.runs.vector.map((h) => h.id),
    );
    expect(candidatesFor(row, "vector", corpus)[0]?.content).toBe("原文 0");
    expect(validateRerankRows([result], [row])).toEqual(new Set(["q1:vector"]));
  });
  it("拒绝少题、重复题和更改问题", () => {
    const { row, corpus, queries } = fixture();
    expect(() => validateBaseline(queries, [], corpus)).toThrow();
    expect(() => validateBaseline(queries, [row, row], corpus)).toThrow();
    expect(() =>
      validateBaseline(queries, [{ ...row, query: "改了" }], corpus),
    ).toThrow();
  });
  it("拒绝丢失原文、重复候选及候选数变化", () => {
    const { row, corpus, queries } = fixture();
    const short = {
      ...row,
      runs: { ...row.runs, vector: row.runs.vector.slice(1) },
    };
    expect(() => validateBaseline(queries, [short], corpus)).toThrow();
    const duplicate = {
      ...row,
      runs: {
        ...row.runs,
        vector: row.runs.vector.map(() => row.runs.vector[0]!),
      },
    };
    expect(() => validateBaseline(queries, [duplicate], corpus)).toThrow();
    corpus.delete("0");
    expect(() => validateBaseline(queries, [row], corpus)).toThrow();
  });
  it("拒绝重复断点及精排偷换候选", () => {
    const { row, result } = fixture();
    expect(() => validateRerankRows([result, result], [row])).toThrow();
    expect(() =>
      validateRerankRows([{ ...result, hits: result.hits.slice(1) }], [row]),
    ).toThrow();
    expect(() =>
      validateRerankRows(
        [
          {
            ...result,
            hits: result.hits.map((h, i) =>
              i === 0 ? { ...h, id: "unknown" } : h,
            ),
          },
        ],
        [row],
      ),
    ).toThrow();
  });
});
