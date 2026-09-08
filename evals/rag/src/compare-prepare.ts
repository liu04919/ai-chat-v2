import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { datasetRoot, comparisonRoot, repo } from "./paths";
import { sha256 } from "./dataset";

const manifest = JSON.parse(readFileSync(join(datasetRoot, "manifest.json"), "utf8"));
const state = JSON.parse(readFileSync(join(datasetRoot, "state.json"), "utf8"));
for (const [file, hash] of Object.entries(manifest.files)) {
  if (sha256(readFileSync(join(datasetRoot, file))) !== hash) throw new Error("DATASET_HASH_MISMATCH");
}
mkdirSync(comparisonRoot, { recursive: true });
for (const variant of ["traditional", "agentic"]) {
  const dest = join(comparisonRoot, variant);
  mkdirSync(dest, { recursive: true });
  for (const name of ["manifest.json", "ATTRIBUTION.md", ...Object.keys(manifest.files)]) {
    const target = join(dest, name);
    if (existsSync(target)) {
      if (sha256(readFileSync(target)) !== sha256(readFileSync(join(datasetRoot, name)))) throw new Error("FROZEN_DATA_CHANGED");
    } else copyFileSync(join(datasetRoot, name), target);
  }
  if (!existsSync(join(dest, "auth-secret.txt"))) copyFileSync(join(datasetRoot, "auth-secret.txt"), join(dest, "auth-secret.txt"));
  if (!existsSync(join(dest, "state.json"))) writeFileSync(join(dest, "state.json"), JSON.stringify({ ...state, attempts: {} }));
}
const plan = {
  protocol: "cmrc2018-paired-agentic-v1", traditionalCommit: "7134eb0", agenticCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  manifestSha256: sha256(readFileSync(join(datasetRoot, "manifest.json"))),
  corpusReuse: "Existing isolated HTTP-ingested evaluation database, same 848 documents / 948 chunks. No duplicate ingestion or BM25 corpus change.",
  model: "gpt-5.6-sol", reasoning: "medium", channel: "Local Codex Proxy / Responses", outputTokenCapPerCall: 8192,
  judge: "gpt-6-astra", judging: "Native Ragas 0.4.3 prompts / schemas, blind structured judgments, native score replay",
  pilot: 5, test: 50, paidRetrievalBudgetCny: 10,
  criteria: ["AnswerAccuracy", "Faithfulness", "known-answer evidence hit in cumulative sources", "citation-format validity", "generation first-attempt completion", "latency", "model calls and tokens", "knowledge-tool calls"],
  limitations: ["Historical test set has been inspected; this is a fixed regression comparison, not a new unseen benchmark", "Short answerable encyclopedic passages; agentic special cases reported separately", "One sampled response per variant/question; model randomness and shared subscription load limit inference", "Extra model calls/context are part of the agentic treatment; record cost, no claim of equal compute", "No automatic retries or post-test prompt tuning"],
};
const target = join(comparisonRoot, "plan.json");
if (!existsSync(target)) writeFileSync(target, JSON.stringify(plan, null, 2));
else if (JSON.stringify(JSON.parse(readFileSync(target, "utf8"))) !== JSON.stringify(plan)) throw new Error("FROZEN_PLAN_CHANGED");
console.log("Comparison prepared; old results untouched, shared paid retrieval budget CNY 10");
