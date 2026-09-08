import { createHash } from "node:crypto";

export const CMRC = {
  repository: "https://github.com/ymcui/cmrc2018",
  revision: "c0eb1b6ba219847457e6af3180da722bbeb656af",
  path: "squad-style-data/cmrc2018_dev.json",
  sha256: "e9ff74231f05c230c6fa88b84441ee334d97234cbb610991cd94b82db00c7f1f",
  license: "CC-BY-SA-4.0",
};
export const SEED = "ai-chat-cmrc2018-rag-v1";
export const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

export type CmrcDataset = {
  data: {
    id: string;
    title: string;
    paragraphs: {
      id: string;
      context: string;
      qas: {
        id: string;
        question: string;
        answers: { text: string; answer_start: number }[];
      }[];
    }[];
  }[];
};
export type CorpusDocument = {
  id: string;
  articleId: string;
  title: string;
  text: string;
};
export type EvalQuestion = {
  id: string;
  documentId: string;
  question: string;
  answers: { text: string; start: number; end: number }[];
};

// 上游 answer_start 按 Unicode 码点计数；业务 chunk 的位置是 JS UTF-16 偏移。
// 必须先核对原始答案，再转换位置，不能把中文字符长度与 token 数混为一谈。
export function answerSpan(context: string, text: string, offset: number) {
  const points = Array.from(context);
  const width = Array.from(text).length;
  if (
    !text || !Number.isSafeInteger(offset) || offset < 0 ||
    points.slice(offset, offset + width).join("") !== text
  ) return null;
  const start = points.slice(0, offset).join("").length;
  return { text, start, end: start + text.length };
}

export function prepareDataset(input: CmrcDataset, pilotCount = 5, testCount = 50) {
  if (![pilotCount, testCount].every((n) => Number.isSafeInteger(n) && n > 0))
    throw new Error("INVALID_SAMPLE_SIZE");
  const corpus: CorpusDocument[] = [];
  const questions: EvalQuestion[] = [];
  const excluded: { id: string; reason: string }[] = [];
  const documentIds = new Set<string>();
  const questionIds = new Set<string>();
  const contentIds = new Map<string, string>();
  for (const article of input.data) {
    for (const paragraph of article.paragraphs) {
      if (!paragraph.id || documentIds.has(paragraph.id) || !paragraph.context.trim())
        throw new Error("INVALID_DOCUMENT");
      documentIds.add(paragraph.id);
      // 相同原文归到同一个候选文档，避免复制语料改变 BM25 统计和切分边界。
      const digest = sha256(paragraph.context);
      const documentId = contentIds.get(digest) ?? paragraph.id;
      if (!contentIds.has(digest)) {
        contentIds.set(digest, documentId);
        corpus.push({ id: documentId, articleId: article.id, title: article.title, text: paragraph.context });
      }
      for (const qa of paragraph.qas) {
        if (!qa.id || questionIds.has(qa.id) || !qa.question.trim())
          throw new Error("INVALID_QUESTION");
        questionIds.add(qa.id);
        const answers = qa.answers.map((a) => answerSpan(paragraph.context, a.text, a.answer_start));
        if (!answers.length || answers.some((a) => a === null)) {
          excluded.push({ id: qa.id, reason: "INVALID_ANSWER_OFFSET" });
          continue;
        }
        questions.push({ id: qa.id, documentId, question: qa.question, answers: answers.filter((a) => a !== null) });
      }
    }
  }
  // 先按源文章分组，试跑/测试不共享文章；同一原文的多个问题不会占满样本。
  const articleByDocument = new Map(corpus.map((d) => [d.id, d.articleId]));
  const ranked = [...questions].sort((a, b) => {
    const left = sha256(`${SEED}:question:${a.id}`);
    const right = sha256(`${SEED}:question:${b.id}`);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const sampled: EvalQuestion[] = [];
  const seenArticles = new Set<string>();
  const seenQuestions = new Set<string>();
  for (const q of ranked) {
    const article = articleByDocument.get(q.documentId)!;
    if (seenArticles.has(article) || seenQuestions.has(q.question.trim())) continue;
    sampled.push(q);
    seenArticles.add(article);
    seenQuestions.add(q.question.trim());
    if (sampled.length === pilotCount + testCount) break;
  }
  if (sampled.length < pilotCount + testCount) throw new Error("INSUFFICIENT_DISTINCT_ARTICLES");
  return {
    corpus, questions, excluded,
    pilot: sampled.slice(0, pilotCount), test: sampled.slice(pilotCount),
  };
}
