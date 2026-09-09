import { readFileSync, writeFileSync, appendFileSync, existsSync, openSync, closeSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase, createKnowledgeRepository, migrateDatabase, type KnowledgeHit } from "@ai-chat/db";
import { chunkPages } from "../../../apps/worker/src/knowledge/parse";
import { createKnowledgeEmbedder } from "../../../apps/worker/src/knowledge/embedding";
import { createKnowledgeReranker } from "../../../apps/worker/src/knowledge/rerank";
import { reciprocalRankFusion } from "../../../apps/worker/src/knowledge/retrieve";
import { executeKnowledgeSearch, knowledgeSearchQueries } from "../../../packages/db/src/knowledge/search";
import { evaluationDatabaseUrl } from "../../retrieval/src/support";
import { sha256, type CorpusDocument, type EvalQuestion } from "./dataset";

const root = fileURLToPath(new URL("../artifacts/cmrc2018/", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const read = <T>(name: string): T => JSON.parse(readFileSync(join(root, name), "utf8")) as T;
const lines = <T>(name: string): T[] => existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8").split("\n").filter(Boolean).map((s) => JSON.parse(s) as T) : [];
const save = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value, null, 2) + "\n");
const append = (name: string, value: unknown) => appendFileSync(join(root, name), JSON.stringify(value) + "\n");

// 小规模预注册网格，不是穷举最优解。800/0 单独检验重叠是否有益。
export const PLAN = { chunks: [[600, 80], [1000, 150], [800, 0], [800, 100]], candidates: [10, 20, 30], retained: [3, 6], seed: "ai-chat-cmrc2018-rag-v1", selection: "max mean known-answer hit@6, then MRR@6; tie keep baseline, else lower retained context bytes" };
type RankedResult = { key: string; id: string; size: number; overlap: number; candidates: number; retained: number; hit: number; mrr: number; contextBytes: number; candidateHit: number; ms: number; hits: { document: string; start: number; end: number; score: number }[] };

export function evidenceMetrics(q: EvalQuestion, hits: KnowledgeHit[]) {
  const relevant = hits.map((h) => h.originalName === `${q.documentId}.txt` && q.answers.some((a) => h.start <= a.start && h.end >= a.end));
  const rank = relevant.indexOf(true);
  return { hit: rank < 0 ? 0 : 1, mrr: rank < 0 ? 0 : 1 / (rank + 1) };
}

async function main() {
  const split = process.argv[2] ?? "tune";
  if (!["tune", "test"].includes(split)) throw new Error("USE_TUNE_OR_TEST");
  const manifest = read<{ files: Record<string, string>; split: { parserSha256: string } }>("manifest.json");
  for (const [file, digest] of Object.entries(manifest.files)) if (sha256(readFileSync(join(root, file))) !== digest) throw new Error("DATASET_CHANGED");
  if (manifest.split.parserSha256 !== sha256(readFileSync(join(repo, "apps/worker/src/knowledge/parse.ts")))) throw new Error("PARSER_CHANGED");
  const plan = { ...PLAN, corpusHash: manifest.files["corpus.json"], model: "qwen3.7-text-embedding", dimensions: 1024, parser: manifest.split.parserSha256 };
  if (existsSync(join(root, "tuning-plan.json")) && JSON.stringify(read("tuning-plan.json")) !== JSON.stringify(plan)) throw new Error("TUNING_PLAN_CHANGED");
  save("tuning-plan.json", plan);
  const runtime = read<{ meterUrl: string; meterToken: string }>("runtime.json");
  if (!runtime.meterUrl.startsWith("http://127.0.0.1:")) throw new Error("LOCAL_METER_REQUIRED");
  const env = { ...process.env, EMBEDDING_BASE_URL: runtime.meterUrl + "/embedding", RERANK_BASE_URL: runtime.meterUrl + "/rerank", DASHSCOPE_API_KEY: runtime.meterToken };
  const embedder = createKnowledgeEmbedder(env, undefined, 20);
  const reranker = createKnowledgeReranker(env);
  if (embedder.model !== plan.model || reranker.model !== "qwen3.7-text-rerank") throw new Error("MODEL_CHANGED");
  const lockPath = join(root, "tuner.lock"); const lock = openSync(lockPath, "wx");
  try {
    const corpus = read<CorpusDocument[]>("corpus.json");
    const questions = read<EvalQuestion[]>(`${split}.json`);
    const cache = new Map(lines<{ key: string; vector: number[] }>("tuning-vectors.jsonl").map((r) => [r.key, r.vector]));
    const vectorKey = (text: string) => sha256(`${plan.model}:1024:${text}`);
    async function embedTexts(texts: string[]) {
      const missing = [...new Set(texts)].filter((text) => !cache.has(vectorKey(text)));
      for (let offset = 0; offset < missing.length; offset += 20) {
        const batch = missing.slice(offset, offset + 20);
        const vectors = await embedder.embed(batch);
        batch.forEach((text, i) => { const key = vectorKey(text); cache.set(key, vectors[i]); append("tuning-vectors.jsonl", { key, vector: vectors[i] }); });
      }
      return texts.map((t) => cache.get(vectorKey(t))!);
    }
    const queryVectors = await embedTexts(questions.map((q) => q.question));
    const previous = lines<RankedResult>(`${split}-retrieval.jsonl`);
    const results = [...previous];
    const done = new Set(previous.map((r) => r.key));
    const winner = split === "test" ? read<{ size: number; overlap: number; candidates: number; retained: number }>("selected-config.json") : undefined;
    for (const [size, overlap] of PLAN.chunks) {
      if (winner && !(size === 800 && overlap === 100) && !(size === winner.size && overlap === winner.overlap)) continue;
      const baseline = size === 800 && overlap === 100;
      const dbUrl = new URL(process.env.DATABASE_URL!);
      dbUrl.pathname = baseline ? "/ai_chat_eval_cmrc2018" : `/ai_chat_eval_cmrc_${size}_${overlap}`;
      evaluationDatabaseUrl(dbUrl.toString(), process.env.DATABASE_URL);
      if (!baseline) {
        const adminUrl = new URL(dbUrl); adminUrl.pathname = "/postgres";
        const admin = createDatabase(adminUrl.toString(), 1);
        try { if (!(await admin.client`SELECT 1 FROM pg_database WHERE datname = ${dbUrl.pathname.slice(1)}`).length) await admin.client.unsafe(`CREATE DATABASE "${dbUrl.pathname.slice(1)}"`); } finally { await admin.close(); }
        await migrateDatabase({ databaseUrl: dbUrl.toString(), migrationsFolder: join(repo, "packages/db/drizzle") });
      }
      const database = createDatabase(dbUrl.toString(), 4);
      try {
        const repository = createKnowledgeRepository(database.db);
        let owner = "cmrc-tuning-owner", base = "cmrc-tuning-base";
        if (baseline) {
          for (let i = 0; i < 1200; i++) {
            const counts = await database.client`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'ready')::int AS ready FROM knowledge_documents`;
            if (counts[0].total === corpus.length && counts[0].ready === corpus.length) break;
            if (i === 1199) throw new Error("BASELINE_NOT_READY");
            await delay(5000);
          }
          const rows = await database.client`SELECT id, owner_id FROM knowledge_bases`;
          if (rows.length !== 1) throw new Error("BASELINE_CORPUS_MISMATCH");
          base = rows[0].id; owner = rows[0].owner_id;
        } else {
          const foreign = await database.client`SELECT id FROM knowledge_bases WHERE id <> ${base}`;
          if (foreign.length) throw new Error("FOREIGN_EVAL_DATA");
          await database.client`INSERT INTO "user" (id,name,email) VALUES (${owner},'CMRC tuning','cmrc-tuning@example.invalid') ON CONFLICT DO NOTHING`;
          await database.client`INSERT INTO knowledge_bases (id,owner_id,name) VALUES (${base},${owner},'CMRC parameter evaluation') ON CONFLICT DO NOTHING`;
          const prepared = await Promise.all(corpus.map(async (d) => ({ document: d, chunks: await chunkPages([{ page: 1, text: d.text }], size, overlap) })));
          await embedTexts(prepared.flatMap((d) => d.chunks.map((c) => c.content)));
          const docs = await repository.listDocuments(owner, base);
          for (const { document, chunks } of prepared) {
            let doc = docs.find((d) => d.originalName === `${document.id}.txt`);
            if (doc?.status === "ready") continue;
            doc ??= await repository.createDocument(owner, base, { originalName: `${document.id}.txt`, mediaType: "text/plain", sizeBytes: Buffer.byteLength(document.text), objectKey: sha256(document.text), status: "pending" });
            if (doc.status === "pending") await repository.claim(doc.id);
            if (!await repository.publish(doc.id, embedder.model, chunks, chunks.map((c) => cache.get(vectorKey(c.content))!))) throw new Error("PUBLISH_FAILED");
          }
          if ((await repository.listDocuments(owner, base)).length !== corpus.length) throw new Error("CORPUS_COUNT_MISMATCH");
          await database.client.unsafe("ANALYZE knowledge_chunks");
        }
        for (const [qi, q] of questions.entries()) for (const candidates of PLAN.candidates) {
          if (winner && !(baseline && candidates === 30) && !(size === winner.size && overlap === winner.overlap && candidates === winner.candidates)) continue;
          const key = `${size}/${overlap}/${candidates}/${q.id}`;
          if (PLAN.retained.every((n) => done.has(`${key}/${n}`))) continue;
          const start = performance.now();
          const found = await executeKnowledgeSearch(database.db, knowledgeSearchQueries(owner, base, q.question, queryVectors[qi], embedder.model, candidates));
          const fused = reciprocalRankFusion([found.semantic, found.lexical]);
          const ranked = (await reranker.rerank(q.question, fused, { topN: 6 })).hits;
          for (const retained of PLAN.retained) {
            const hits = ranked.slice(0, retained);
            const result: RankedResult = { key: `${key}/${retained}`, id: q.id, size, overlap, candidates, retained, ...evidenceMetrics(q, hits), candidateHit: evidenceMetrics(q, fused).hit, contextBytes: hits.reduce((n, h) => n + Buffer.byteLength(h.content), 0), ms: performance.now() - start, hits: hits.map((h) => ({ document: h.originalName, start: h.start, end: h.end, score: h.rerankScore })) };
            append(`${split}-retrieval.jsonl`, result); results.push(result); done.add(result.key);
          }
          console.log(`${split} ${size}/${overlap} top${candidates} ${qi + 1}/${questions.length}`);
        }
      } finally { await database.close(); }
    }
    if (split === "tune") {
      const groups = PLAN.chunks.flatMap(([size, overlap]) => PLAN.candidates.flatMap((candidates) => PLAN.retained.map((retained) => {
        const group = results.filter((r) => r.size === size && r.overlap === overlap && r.candidates === candidates && r.retained === retained);
        if (group.length !== questions.length) throw new Error("INCOMPLETE_TUNING_GRID");
        const mean = (f: (r: RankedResult) => number) => group.reduce((n, r) => n + f(r), 0) / group.length;
        return { size, overlap, candidates, retained, knownAnswerHit: mean((r) => r.hit), mrr: mean((r) => r.mrr), contextBytes: mean((r) => r.contextBytes), candidateHit: mean((r) => r.candidateHit) };
      })));
      const baseline = (g: typeof groups[number]) => Number(g.size === 800 && g.overlap === 100 && g.candidates === 30 && g.retained === 6);
      groups.sort((a, b) => b.knownAnswerHit - a.knownAnswerHit || b.mrr - a.mrr || baseline(b) - baseline(a) || a.contextBytes - b.contextBytes);
      save("tuning-summary.json", groups); save("selected-config.json", groups[0]);
    }
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
// 作为测试模块导入时不启动付费调用。
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/tune.ts")) main().catch(() => { console.error("TUNING_FAILED"); process.exitCode = 1; });
