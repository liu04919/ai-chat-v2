import { describe, expect, it } from "vitest";
import { evidenceMetrics } from "./tune";
import { citationFormat, interval } from "./report";
import type { KnowledgeHit } from "@ai-chat/db";

describe("RAG evaluation metric boundaries", () => {
  const q = { id: "q", documentId: "doc", question: "问题", answers: [{ text: "答案", start: 10, end: 12 }] };
  const hit: KnowledgeHit = { id: "c", documentId: "db-doc-id", originalName: "doc.txt", page: 1, start: 0, end: 20, content: "原文", score: 1 };
  it("requires the source document and the full annotated answer span", () => {
    expect(evidenceMetrics(q, [{ ...hit, originalName: "other.txt" }, hit])).toEqual({ hit: 1, mrr: 0.5 });
    expect(evidenceMetrics(q, [{ ...hit, end: 11 }])).toEqual({ hit: 0, mrr: 0 });
    expect(evidenceMetrics(q, [])).toEqual({ hit: 0, mrr: 0 });
  });
  it("checks citation numbering, not semantic correctness", () => {
    const source = { number: 1, chunkId: "c", documentId: "d", originalName: "doc.txt", page: 1, content: "资料" };
    expect(citationFormat("说法[1](#knowledge-1) [2](#knowledge-1) [9](#knowledge-9)", [source])).toEqual({ count: 3, valid: 1 });
  });
  it("keeps deterministic bootstrap intervals", () => {
    expect(interval([1, 1, 1])).toEqual({ mean: 1, ci95: [1, 1] });
    expect(interval([0, 1, 0.5])).toEqual(interval([0, 1, 0.5]));
  });
});
