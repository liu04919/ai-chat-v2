import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { KnowledgeChunk } from "@ai-chat/contracts";
import { parseKnowledgeFile } from "../../../apps/worker/src/knowledge/parse";
import { CMRC, SEED, prepareDataset, sha256, type CmrcDataset } from "./dataset";

const root = fileURLToPath(new URL("../artifacts/cmrc2018/", import.meta.url));
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
async function main() {
  mkdirSync(root, { recursive: true });
  const rawPath = join(root, "cmrc2018_dev.json");
  let bytes: Uint8Array;
  if (existsSync(rawPath)) bytes = readFileSync(rawPath);
  else {
    const response = await fetch(`https://raw.githubusercontent.com/ymcui/cmrc2018/${CMRC.revision}/${CMRC.path}`, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error("DATASET_DOWNLOAD_FAILED");
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  if (sha256(bytes) !== CMRC.sha256) throw new Error("UPSTREAM_HASH_MISMATCH");
  const sampled = prepareDataset(JSON.parse(new TextDecoder().decode(bytes)) as CmrcDataset, 5, 70);
  // 新增调参题，不改变已经固定的 5 题试跑和 50 题测试集。
  const dataset = { ...sampled, test: sampled.test.slice(0, 50), tune: sampled.test.slice(50) };
  const chunks: (KnowledgeChunk & { id: string; documentId: string })[] = [];
  mkdirSync(join(root, "documents"), { recursive: true });
  for (const document of dataset.corpus) {
    if (!/^[a-zA-Z0-9_-]+$/.test(document.id)) throw new Error("UNSAFE_DOCUMENT_ID");
    const buffer = new TextEncoder().encode(document.text);
    const parsed = await parseKnowledgeFile(buffer, "text/plain");
    chunks.push(...parsed.map((chunk, index) => ({ id: `${document.id}:${index}`, documentId: document.id, ...chunk })));
    writeFileSync(join(root, "documents", `${document.id}.txt`), buffer);
  }
  // 标注的是“原文里已知的答案区间”，不是对所有相关 chunk 的穷尽人工标注。
  const annotate = (questions: typeof dataset.test) => questions.map((q) => ({
    ...q,
    evidenceChunkIds: chunks.filter((c) => c.documentId === q.documentId && q.answers.some((a) => c.start <= a.start && c.end >= a.end)).map((c) => c.id),
  }));
  const files: Record<string, string> = {};
  for (const [name, value] of Object.entries({
    "corpus.json": dataset.corpus,
    "chunks.json": chunks,
    "pilot.json": annotate(dataset.pilot),
    "test.json": annotate(dataset.test),
    "tune.json": annotate(dataset.tune),
    "excluded.json": dataset.excluded,
  })) {
    const content = json(value);
    writeFileSync(join(root, name), content);
    files[name] = sha256(content);
  }
  writeFileSync(rawPath, bytes);
  const manifest = {
    source: CMRC, seed: SEED, files,
    corpusCount: dataset.corpus.length, originalQuestionCount: dataset.questions.length + dataset.excluded.length,
    eligibleQuestionCount: dataset.questions.length, excludedQuestionCount: dataset.excluded.length,
    pilotCount: dataset.pilot.length, testCount: dataset.test.length,
    tuneCount: dataset.tune.length,
    corpusCharacters: dataset.corpus.reduce((n, d) => n + d.text.length, 0),
    corpusUtf8Bytes: dataset.corpus.reduce((n, d) => n + Buffer.byteLength(d.text), 0),
    chunkCount: chunks.length,
    chunkUtf8Bytes: chunks.reduce((n, c) => n + Buffer.byteLength(c.content), 0),
    split: { size: 800, overlap: 100, unit: "JS UTF-16 characters", parserSha256: sha256(readFileSync(fileURLToPath(new URL("../../../apps/worker/src/knowledge/parse.ts", import.meta.url)))) },
    selectedQuestionsWithoutContainedAnswer: annotate([...dataset.pilot, ...dataset.test, ...dataset.tune]).filter((q) => !q.evidenceChunkIds.length).map((q) => q.id),
    protocol: "Full dev corpus; 5 pilot + 20 tuning + 50 held-out test, disjoint source articles; adapted full-RAG evaluation, NOT official CMRC leaderboard",
  };
  writeFileSync(join(root, "manifest.json"), json(manifest));
  writeFileSync(join(root, "ATTRIBUTION.md"), `CMRC 2018 — Yiming Cui et al.\n\nSource: ${CMRC.repository}\nRevision: ${CMRC.revision}\nLicense: ${CMRC.license}\nLicense text: ${CMRC.repository}/blob/${CMRC.revision}/LICENCE\n\nAdaptation: context-only TXT exports, business 800/100 chunking, deterministic question sampling and UTF-16 answer offsets.\n`);
  console.log(json(manifest));
}
main().catch(() => { console.error("CMRC_PREPARATION_FAILED"); process.exitCode = 1; });
