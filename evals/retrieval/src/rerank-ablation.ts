import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKnowledgeReranker } from "../../../apps/worker/src/knowledge/rerank";
import { appendJson, Budget, hash, readJsonl, upperTokens } from "./support";
import {
  candidatesFor,
  rerankArms,
  validateBaseline,
  validateRerankRows,
  type BaselineRow,
  type Passage,
  type RerankRow,
} from "./rerank-ablation-support";

const root = fileURLToPath(new URL("../", import.meta.url));
const baselineDirectory = join(root, "artifacts/duretrieval");
const output = join(root, "artifacts/duretrieval-rerank-ablation");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const save = (name: string, data: unknown) =>
  writeFileSync(join(output, name), JSON.stringify(data, null, 2) + "\n");

async function main() {
  const command = process.argv[2];
  if (command !== "estimate" && command !== "run")
    throw new Error("USE_ESTIMATE_OR_RUN");
  if (process.env.RERANK_MODEL !== "qwen3.7-text-rerank")
    throw new Error("REVIEW_MODEL_PRICING_FIRST");
  // 与旧评测共用锁和账本，不能通过新建补测目录重新获得 20 元预算。
  const lockPath = join(baselineDirectory, "runner.lock");
  const lock = openSync(lockPath, "wx");
  try {
    const budget = new Budget(join(baselineDirectory, "usage.jsonl"), 20);
    const manifest = json(join(baselineDirectory, "manifest.json"));
    for (const [name, digest] of Object.entries(manifest.files)) {
      if (hash(readFileSync(join(baselineDirectory, name))) !== digest)
        throw new Error("DATASET_HASH_MISMATCH");
    }
    const passages = readJsonl<Passage>(
      join(baselineDirectory, "corpus.jsonl"),
    );
    const corpus = new Map(passages.map((p) => [p.id, p.text]));
    if (corpus.size !== manifest.corpusCount || corpus.size !== passages.length)
      throw new Error("INVALID_CORPUS");
    const queries = readJsonl<Passage>(
      join(baselineDirectory, "queries.jsonl"),
    );
    const baseline = readJsonl<BaselineRow>(
      join(baselineDirectory, "results.jsonl"),
    );
    validateBaseline(queries, baseline, corpus);
    const prior = json(join(baselineDirectory, "run.json"));
    if (
      prior.parameters.candidateLimit !== 50 ||
      prior.parameters.rerankTopN !== 50 ||
      prior.parameters.rerankModel !== process.env.RERANK_MODEL
    )
      throw new Error("BASELINE_MODEL_OR_LIMIT_MISMATCH");
    const requests = baseline.flatMap((r) =>
      rerankArms.map((arm) => ({
        id: r.id,
        arm,
        reservedTokens: upperTokens(
          candidatesFor(r, arm, corpus).map((c) => c.content),
          r.query,
        ),
      })),
    );
    console.info(
      JSON.stringify({
        queries: baseline.length,
        calls: requests.length,
        cumulativeBudget: budget.summary(),
        allRequestsReservationCny: requests.reduce(
          (n, r) => n + (r.reservedTokens * 0.5) / 1e6,
          0,
        ),
        note: "Reservation is a per-request conservative upper bound, not estimated bill; successful requests settle by usage. No embedding or database calls.",
      }),
    );
    if (command === "estimate") return;

    mkdirSync(output, { recursive: true });
    const checkout = resolve(root, "../..");
    const sources = [
      "apps/worker/src/knowledge/rerank.ts",
      "evals/retrieval/src/rerank-ablation.ts",
      "evals/retrieval/src/rerank-ablation-support.ts",
      "evals/retrieval/src/support.ts",
    ];
    const parameters = {
      baselineFiles: Object.fromEntries(
        ["manifest.json", "run.json", "results.jsonl", "qrels.json"].map(
          (name) => [name, hash(readFileSync(join(baselineDirectory, name)))],
        ),
      ),
      sourceHashes: Object.fromEntries(
        sources.map((name) => [name, hash(readFileSync(join(checkout, name)))]),
      ),
      rerankModel: process.env.RERANK_MODEL,
      providerEndpointHash: hash(process.env.RERANK_BASE_URL ?? ""),
      candidateLimit: 50,
      rerankTopN: 50,
      order:
        "alternate vector-first and hybrid-first by fixed query order; sequential requests",
    };
    const runPath = join(output, "run.json");
    if (existsSync(runPath)) {
      if (
        hash(JSON.stringify(json(runPath).parameters)) !==
        hash(JSON.stringify(parameters))
      )
        throw new Error("ABLATION_CONFIGURATION_CHANGED_USE_NEW_DIRECTORY");
    } else {
      if (existsSync(join(output, "results.jsonl")))
        throw new Error("CHECKPOINT_WITHOUT_MANIFEST");
      save("run.json", {
        parameters,
        startedAt: new Date().toISOString(),
        baselineStartedAt: prior.startedAt,
        corpusCount: corpus.size,
        queries: queries.length,
        budgetAtStart: budget.summary(),
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
        timingPolicy:
          "Only rerank requests timed freshly; no database, SQL or embedding calls. Old retrieval timings are not current end-to-end latency.",
      });
    }
    const resultPath = join(output, "results.jsonl");
    const completed = validateRerankRows(
      readJsonl<RerankRow>(resultPath),
      baseline,
    );
    const reranker = createKnowledgeReranker();
    try {
      for (const [index, row] of baseline.entries()) {
        const order = index % 2 === 0 ? rerankArms : [...rerankArms].reverse();
        for (const arm of order) {
          if (completed.has(`${row.id}:${arm}`)) continue;
          const candidates = candidatesFor(row, arm, corpus);
          const settle = budget.reserve(
            `ablation-${arm}-rerank`,
            upperTokens(
              candidates.map((c) => c.content),
              row.query,
            ),
          );
          const started = performance.now();
          try {
            const response = await reranker.rerank(row.query, candidates, {
              topN: 50,
            });
            const rerankMs = performance.now() - started;
            if (response.totalTokens !== null) settle(response.totalTokens);
            const result: RerankRow = {
              id: row.id,
              arm,
              hits: response.hits.map((h) => ({
                id: h.id,
                score: h.score,
                rerankScore: h.rerankScore,
              })),
              tokens: response.totalTokens,
              requestId: response.requestId,
              rerankMs,
            };
            validateRerankRows([result], [row]);
            appendJson(resultPath, result);
            completed.add(`${row.id}:${arm}`);
          } catch {
            // 不输出上游正文、URL 或 Key；失败保留预算预留，人工检查后再续跑。
            appendJson(join(output, "failures.jsonl"), {
              id: row.id,
              arm,
              error: "RERANK_ATTEMPT_FAILED",
              at: new Date().toISOString(),
            });
            throw new Error("ABLATION_INCOMPLETE_SEE_FAILURES");
          }
        }
        if ((index + 1) % 10 === 0)
          console.info(
            JSON.stringify({
              completedCalls: completed.size,
              totalCalls: requests.length,
              cumulativeCny: budget.usedCny,
            }),
          );
      }
      console.info("Complete: both rerank arms finished for every query.");
    } finally {
      const start = json(runPath).budgetAtStart.accountedCny;
      save("cost.json", {
        ...budget.summary(),
        incrementalAccountedCny: budget.usedCny - start,
      });
    }
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "ABLATION_FAILED";
  console.error(
    /^[A-Z][A-Z0-9_]+$/.test(message) ? message : "ABLATION_FAILED",
  );
  process.exitCode = 1;
});
