import { describe, expect, it } from "vitest";
import { answerSpan, prepareDataset, type CmrcDataset } from "./dataset";

function fixture(count = 8): CmrcDataset {
  return { data: Array.from({ length: count }, (_, i) => ({
    id: `article-${i}`, title: `标题${i}`, paragraphs: [{
      id: `document-${i}`, context: `这是答案${i}。`,
      qas: [0, 1].map((j) => ({ id: `question-${i}-${j}`, question: `第${i}题-${j}？`, answers: [{ text: `答案${i}`, answer_start: 2 }] })),
    }],
  })) };
}

describe("CMRC preparation", () => {
  it("converts Python code-point offsets to business UTF-16 offsets", () => {
    expect(answerSpan("😀这是答案。", "答案", 3)).toEqual({ text: "答案", start: 4, end: 6 });
    expect(answerSpan("测试", "答案", 0)).toBeNull();
    expect(answerSpan("测试", "", 0)).toBeNull();
  });
  it("keeps the entire candidate corpus and separates pilot/test articles", () => {
    const input = fixture();
    const result = prepareDataset(input, 2, 3);
    expect(result.corpus).toHaveLength(8);
    expect(result.questions).toHaveLength(16);
    expect(result.pilot).toHaveLength(2);
    expect(result.test).toHaveLength(3);
    expect(new Set([...result.pilot, ...result.test].map((q) => q.documentId)).size).toBe(5);
    expect(prepareDataset({ data: [...input.data].reverse() }, 2, 3).test).toEqual(result.test);
  });
  it("records invalid annotations instead of repairing them with answer-text search", () => {
    const input = fixture();
    input.data[0].paragraphs[0].qas[0].answers[0].answer_start = 0;
    const result = prepareDataset(input, 1, 2);
    expect(result.excluded).toEqual([{ id: "question-0-0", reason: "INVALID_ANSWER_OFFSET" }]);
    expect(result.corpus).toHaveLength(8);
  });
  it("deduplicates exact contexts without losing questions or allowing split leakage", () => {
    const input = fixture();
    input.data[1].paragraphs[0].context = input.data[0].paragraphs[0].context;
    input.data[1].paragraphs[0].qas.forEach((q) => { q.answers[0].text = "答案0"; });
    const result = prepareDataset(input, 2, 3);
    expect(result.corpus).toHaveLength(7);
    expect(result.questions.find((q) => q.id === "question-1-0")?.documentId).toBe("document-0");
  });
  it("rejects duplicate IDs and oversized samples", () => {
    expect(() => prepareDataset(fixture(), 5, 50)).toThrow("INSUFFICIENT_DISTINCT_ARTICLES");
    const input = fixture();
    input.data[1].paragraphs[0].id = "document-0";
    expect(() => prepareDataset(input, 1, 1)).toThrow("INVALID_DOCUMENT");
  });
});
