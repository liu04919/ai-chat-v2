import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { comparisonRoot, repo } from "./paths";
import { sha256 } from "./dataset";

// 修复版完整重跑，不覆盖旧版的 43 次成功、7 次失败及其评分记录。
const source = join(comparisonRoot, "agentic");
const dest = join(comparisonRoot, "agentic-fixed");
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const original = JSON.parse(readFileSync(join(comparisonRoot, "plan.json"), "utf8"));
if (git("rev-parse", "HEAD") !== original.agenticCommit) throw new Error("BASE_COMMIT_CHANGED");
const changed = git("diff", "--name-only", "--", "apps/worker", "packages").split("\n").filter(Boolean);
if (changed.some((name) => !name.endsWith(".test.ts") && name !== "packages/contracts/src/generation-event.ts")) throw new Error("UNRELATED_BUSINESS_CHANGE");
if (git("ls-files", "--others", "--exclude-standard", "apps/worker", "packages")) throw new Error("UNTRACKED_BUSINESS_CHANGE");
const patch = git("diff", "--no-ext-diff", "--", "packages/contracts/src/generation-event.ts");
if (!patch.includes("knowledgeSourcesPartSchema.shape.sources")) throw new Error("SOURCE_FIX_REQUIRED");
const revision = { baseCommit: original.agenticCommit, patchSha256: sha256(patch), change: "SSE sources reuse message snapshot schema (18 max)", previousRun: "agentic", rerun: "all 5 pilot and 50 test questions; no previous answers reused" };
mkdirSync(dest, { recursive: true });
const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
for (const [file, hash] of Object.entries(manifest.files)) {
  if (sha256(readFileSync(join(source, file))) !== hash) throw new Error("DATASET_HASH_MISMATCH");
}
for (const file of ["manifest.json", "ATTRIBUTION.md", "auth-secret.txt", ...Object.keys(manifest.files)]) {
  const target = join(dest, file);
  if (existsSync(target)) {
    if (sha256(readFileSync(target)) !== sha256(readFileSync(join(source, file)))) throw new Error("FROZEN_DATA_CHANGED");
  } else copyFileSync(join(source, file), target);
}
const revisionPath = join(dest, "revision.json");
if (existsSync(revisionPath)) {
  if (JSON.stringify(JSON.parse(readFileSync(revisionPath, "utf8"))) !== JSON.stringify(revision)) throw new Error("FROZEN_REVISION_CHANGED");
} else {
  writeFileSync(revisionPath, JSON.stringify(revision, null, 2));
  writeFileSync(join(dest, "source-limit.patch"), patch);
}
if (!existsSync(join(dest, "state.json"))) {
  const state = JSON.parse(readFileSync(join(source, "state.json"), "utf8"));
  writeFileSync(join(dest, "state.json"), JSON.stringify({ ...state, attempts: {} }));
}
console.log(JSON.stringify({ variant: "agentic-fixed", revision, paidBudget: "shared original CNY 10 ledger" }));
