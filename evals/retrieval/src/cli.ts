import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDatabase,
  migrateDatabase,
  knowledgeChunks,
  type KnowledgeHit,
} from "@ai-chat/db";
import { sql } from "drizzle-orm";
import {
  knowledgeSearchQueries,
  executeKnowledgeSearch,
} from "../../../packages/db/src/knowledge/search";
import { createKnowledgeEmbedder } from "../../../apps/worker/src/knowledge/embedding";
import { createKnowledgeReranker } from "../../../apps/worker/src/knowledge/rerank";
import { reciprocalRankFusion } from "../../../apps/worker/src/knowledge/retrieve";
import {
  Budget,
  upperTokens,
  evaluationDatabaseUrl,
  hash,
  appendJson,
  readJsonl,
} from "./support";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = join(root, "artifacts/duretrieval");
const owner = "evaluation-owner";
const base = "duretrieval";
const document = "duretrieval-corpus";
const limit = 50;
type Passage = { id: string; text: string };
type Manifest = {
  corpusCount: number;
  files: Record<string, string>;
  [key: string]: unknown;
};

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  // SDK 错误可能含请求正文、URL 和凭证，不写入报告。
  return /^[A-Z][A-Z0-9_]+$/.test(message) ? message : "EVAL_OPERATION_FAILED";
}
function errorDetails(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  const e = error as {
    name?: string;
    statusCode?: number;
    code?: string;
    cause?: unknown;
    responseBody?: string;
  };
  let providerCode: unknown;
  let providerMessage: string | undefined;
  try {
    const body = JSON.parse(e.responseBody ?? "{}");
    providerCode = body.code ?? body.error?.code;
    const message = body.message ?? body.error?.message;
    if (typeof message === "string")
      providerMessage = message
        .replace(/sk-[\w.\-]+/g, "[redacted]")
        .replace(/https?:\/\/\S+/g, "[url]")
        .slice(0, 300);
  } catch {}
  return {
    name: e.name,
    status: e.statusCode,
    code: e.code,
    providerCode,
    providerMessage,
    cause: errorDetails(e.cause),
  };
}
function save(name: string, data: unknown) {
  writeFileSync(join(artifacts, name), JSON.stringify(data, null, 2) + "\n");
}

async function main() {
  const command = process.argv[2];
  if (!["init", "ingest", "run"].includes(command ?? ""))
    throw new Error("USE_INIT_INGEST_RUN");
  const url = evaluationDatabaseUrl(
    process.env.EVAL_DATABASE_URL,
    process.env.DATABASE_URL,
  );
  if (
    process.env.EMBEDDING_MODEL !== "qwen3.7-text-embedding" ||
    process.env.RERANK_MODEL !== "qwen3.7-text-rerank"
  )
    throw new Error("REVIEW_MODEL_PRICING_FIRST");
  mkdirSync(artifacts, { recursive: true });
  // 单进程保护预算账本和断点文件；异常退出遗留锁必须先确认进程已停止再移除。
  const lockPath = join(artifacts, "runner.lock");
  const lock = openSync(lockPath, "wx");
  let budget: Budget | undefined;
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    budget = new Budget(
      join(artifacts, "usage.jsonl"),
      Number(process.env.EVAL_BUDGET_CNY ?? 20),
    );
    const manifest: Manifest = JSON.parse(
      readFileSync(join(artifacts, "manifest.json"), "utf8"),
    );
    for (const [name, digest] of Object.entries(manifest.files)) {
      if (hash(readFileSync(join(artifacts, name))) !== digest)
        throw new Error("DATASET_HASH_MISMATCH");
    }
    const corpus = readJsonl<Passage>(join(artifacts, "corpus.jsonl"));
    if (
      corpus.length !== manifest.corpusCount ||
      new Set(corpus.map((x) => x.id)).size !== corpus.length
    )
      throw new Error("INVALID_CORPUS");
    const corpusHash = hash(
      JSON.stringify({
        file: manifest.files["corpus.jsonl"],
        model: process.env.EMBEDDING_MODEL,
        dimensions: 1024,
        policy: "unchanged passage",
      }),
    );
    const metadataPath = join(artifacts, "database.json");
    if (existsSync(metadataPath)) {
      const previous = JSON.parse(readFileSync(metadataPath, "utf8"));
      if (
        previous.corpusHash !== corpusHash ||
        previous.database !== url.pathname
      )
        throw new Error("EVAL_DATABASE_MANIFEST_MISMATCH");
    }
    if (command === "init") {
      const adminUrl = new URL(url);
      adminUrl.pathname = "/postgres";
      const admin = createDatabase(adminUrl.toString(), 1);
      try {
        const name = url.pathname.slice(1);
        const existing =
          await admin.client`SELECT 1 FROM pg_database WHERE datname = ${name}`;
        if (!existing.length)
          await admin.client.unsafe(`CREATE DATABASE "${name}"`);
      } finally {
        await admin.close();
      }
      await migrateDatabase({
        databaseUrl: url.toString(),
        migrationsFolder: resolve(root, "../../packages/db/drizzle"),
      });
    }
    database = createDatabase(url.toString(), 6);
    const s = database.client;
    if (command === "init") {
      const foreign =
        await s`SELECT id FROM knowledge_documents WHERE id <> ${document}`;
      if (foreign.length)
        throw new Error("EVAL_DATABASE_CONTAINS_OTHER_CORPUS");
      await s`INSERT INTO "user" (id, name, email) VALUES (${owner}, 'Offline evaluation', 'offline-evaluation@example.invalid') ON CONFLICT DO NOTHING`;
      await s`INSERT INTO knowledge_bases (id, owner_id, name) VALUES (${base}, ${owner}, 'C-MTEB/DuRetrieval') ON CONFLICT DO NOTHING`;
      await s`INSERT INTO knowledge_documents (id, knowledge_base_id, object_key, original_name, media_type, size_bytes, status, embedding_model)
        VALUES (${document}, ${base}, ${corpusHash}, 'DuRetrieval original passages', 'text/plain', 0, 'processing', ${process.env.EMBEDDING_MODEL!}) ON CONFLICT DO NOTHING`;
      save("database.json", { database: url.pathname, corpusHash });
      console.info(
        "Evaluation database initialized; business database untouched.",
      );
      return;
    }
    if (!existsSync(metadataPath)) throw new Error("RUN_INIT_FIRST");
    const docs = await s`SELECT id, object_key FROM knowledge_documents`;
    if (
      docs.length !== 1 ||
      docs[0]?.id !== document ||
      docs[0]?.object_key !== corpusHash
    )
      throw new Error("EVAL_DATABASE_CORPUS_MISMATCH");

    async function embed(texts: string[], kind: string) {
      const settle = budget!.reserve(kind, upperTokens(texts));
      let tokens = 0;
      const embedder = createKnowledgeEmbedder(
        process.env,
        (n) => {
          tokens += n;
        },
        20,
      );
      try {
        const vectors = await embedder.embed(texts);
        settle(tokens);
        return vectors;
      } catch (error) {
        // 整批失败时保留预留，已成功子批次也不会从费用记录消失。
        appendJson(join(artifacts, "failures.jsonl"), {
          kind,
          error: safeError(error),
          details: errorDetails(error),
          knownTokens: tokens,
          at: new Date().toISOString(),
        });
        throw new Error("EMBEDDING_BATCH_FAILED");
      }
    }
    if (command === "ingest") {
      const known = new Set(
        (await s`SELECT id FROM knowledge_chunks`).map((row) => String(row.id)),
      );
      const corpusIds = new Set(corpus.map((r) => r.id));
      if ([...known].some((id) => !corpusIds.has(id)))
        throw new Error("UNKNOWN_CORPUS_ID");
      const pending = corpus
        .map((row, ordinal) => ({ ...row, ordinal }))
        .filter((row) => !known.has(row.id));
      console.info(
        JSON.stringify({
          existing: known.size,
          pending: pending.length,
          budget: budget.summary(),
        }),
      );
      let cursor = 0,
        complete = known.size;
      let failed = false;
      const concurrency = Number(process.env.EVAL_CONCURRENCY ?? 4);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
        throw new Error("INVALID_CONCURRENCY");
      // qwen3.7 官方支持每批 20 条；默认业务批次仍为 10。
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (!failed && cursor < pending.length) {
            const batch = pending.slice(cursor, cursor + 20);
            cursor += batch.length;
            try {
              const vectors = await embed(
                batch.map((r) => r.text),
                "corpus-embedding",
              );
              await database!.db.insert(knowledgeChunks).values(
                batch.map((row, i) => ({
                  id: row.id,
                  documentId: document,
                  ordinal: row.ordinal,
                  content: row.text,
                  page: 1,
                  start: 0,
                  end: row.text.length,
                  embedding: vectors[i]!,
                })),
              );
              complete += batch.length;
              if (
                Math.floor(complete / 500) >
                  Math.floor((complete - batch.length) / 500) ||
                complete === corpus.length
              )
                console.info(
                  JSON.stringify({
                    complete,
                    total: corpus.length,
                    budget: budget!.summary(),
                  }),
                );
            } catch (error) {
              failed = true;
              appendJson(join(artifacts, "failures.jsonl"), {
                kind: "ingest",
                ids: batch.map((r) => r.id),
                error: safeError(error),
              });
            }
          }
        }),
      );
      if (failed) throw new Error("INGEST_INCOMPLETE_SEE_FAILURES");
      const count =
        await s`SELECT count(*)::integer AS n FROM knowledge_chunks`;
      if (count[0]?.n !== corpus.length) throw new Error("INCOMPLETE_CORPUS");
      await s`UPDATE knowledge_documents SET status = 'ready', chunk_count = ${corpus.length} WHERE id = ${document}`;
      await s`ANALYZE knowledge_chunks`;
      await s`ANALYZE knowledge_documents`;
      console.info("Full corpus ready.");
      return;
    }

    const ready =
      await s`SELECT chunk_count FROM knowledge_documents WHERE id = ${document} AND status = 'ready'`;
    const count = await s`SELECT count(*)::integer AS n FROM knowledge_chunks`;
    if (
      ready[0]?.chunk_count !== corpus.length ||
      count[0]?.n !== corpus.length
    )
      throw new Error("INGEST_FULL_CORPUS_FIRST");
    const queries = readJsonl<Passage>(join(artifacts, "queries.jsonl"));
    const resultPath = join(artifacts, "results.jsonl");
    const completed = new Set(
      readJsonl<{ id: string }>(resultPath).map((r) => r.id),
    );
    const reranker = createKnowledgeReranker();
    const sourcePaths = [
      "packages/db/src/knowledge/search.ts",
      "apps/worker/src/knowledge/embedding.ts",
      "apps/worker/src/knowledge/rerank.ts",
      "apps/worker/src/knowledge/retrieve.ts",
      "evals/retrieval/src/cli.ts",
      "evals/retrieval/src/support.ts",
    ];
    const checkout = resolve(root, "../..");
    const parameters = {
      corpusHash,
      queriesHash: manifest.files["queries.jsonl"],
      candidateLimit: limit,
      rrfK: 60,
      rerankTopN: limit,
      embeddingModel: process.env.EMBEDDING_MODEL,
      rerankModel: reranker.model,
      dimensions: 1024,
      sourceHashes: Object.fromEntries(
        sourcePaths.map((p) => [p, hash(readFileSync(join(checkout, p)))]),
      ),
    };
    const runPath = join(artifacts, "run.json");
    if (
      existsSync(runPath) &&
      hash(
        JSON.stringify(JSON.parse(readFileSync(runPath, "utf8")).parameters),
      ) !== hash(JSON.stringify(parameters))
    )
      throw new Error("RUN_CONFIGURATION_CHANGED_USE_NEW_RESULTS_DIRECTORY");
    const extensions =
      await s`SELECT extname, extversion FROM pg_extension ORDER BY extname`;
    if (!existsSync(runPath))
      save("run.json", {
        parameters,
        extensions,
        gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: checkout,
          encoding: "utf8",
        }).trim(),
        dirty: Boolean(
          execFileSync("git", ["status", "--porcelain"], {
            cwd: checkout,
            encoding: "utf8",
          }).trim(),
        ),
        startedAt: new Date().toISOString(),
        timingPolicy:
          "Both SQL branches run concurrently. Branch latency is observed under shared load, not standalone throughput. Query embedding reused across arms; RRF and rerank timed separately.",
      });
    const compact = (hits: KnowledgeHit[]) =>
      hits.map((h) => ({
        id: h.id,
        score: h.score,
        ...("rerankScore" in h ? { rerankScore: h.rerankScore } : {}),
      }));
    for (const query of queries) {
      if (completed.has(query.id)) continue;
      const started = performance.now();
      try {
        const [vector] = await embed([query.text], "query-embedding");
        const embeddingMs = performance.now() - started;
        const search = knowledgeSearchQueries(
          owner,
          base,
          query.text,
          vector!,
          process.env.EMBEDDING_MODEL!,
          limit,
        );
        const retrieved = await executeKnowledgeSearch(database.db, search);
        const fusionStart = performance.now();
        const hybrid = reciprocalRankFusion([
          retrieved.semantic,
          retrieved.lexical,
        ]).slice(0, limit);
        const fusionMs = performance.now() - fusionStart;
        const settle = hybrid.length
          ? budget.reserve(
              "rerank",
              upperTokens(
                hybrid.map((h) => h.content),
                query.text,
              ),
            )
          : undefined;
        const rerankStart = performance.now();
        const reranked = await reranker.rerank(query.text, hybrid, {
          topN: limit,
        });
        if (reranked.totalTokens !== null) settle?.(reranked.totalTokens);
        const rerankMs = performance.now() - rerankStart;
        const result = {
          id: query.id,
          query: query.text,
          runs: {
            vector: compact(retrieved.semantic),
            bm25: compact(retrieved.lexical),
            hybrid: compact(hybrid),
            hybrid_rerank: compact(reranked.hits),
          },
          timing: {
            embeddingMs,
            ...retrieved.timing,
            fusionMs,
            rerankMs,
            totalMs: performance.now() - started,
          },
          rerankTokens: reranked.totalTokens,
          requestId: reranked.requestId,
        };
        appendJson(resultPath, result);
        completed.add(query.id);
        console.info(
          JSON.stringify({
            queries: completed.size,
            total: queries.length,
            budget: budget.summary(),
          }),
        );
        if (completed.size === 1) {
          const plans = await database.db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL hnsw.iterative_scan = strict_order`);
            return {
              semantic: await tx.execute(
                sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${search.semantic}`,
              ),
              lexical: await tx.execute(
                sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${search.lexical}`,
              ),
            };
          });
          save("plans.json", plans);
        }
      } catch (error) {
        appendJson(join(artifacts, "failures.jsonl"), {
          kind: "query",
          id: query.id,
          error: safeError(error),
          at: new Date().toISOString(),
        });
        throw new Error("EVALUATION_INCOMPLETE_SEE_FAILURES");
      }
    }
    console.info("All queries completed; run score.py for ranx metrics.");
  } finally {
    try {
      if (budget) save("cost.json", budget.summary());
      await database?.close();
    } finally {
      closeSync(lock);
      unlinkSync(lockPath);
    }
  }
}

main().catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
