import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export const repo = fileURLToPath(new URL("../../../", import.meta.url));
export const datasetRoot = join(repo, "evals/rag/artifacts/cmrc2018");
export const comparisonRoot = join(repo, "evals/rag/artifacts/agentic-v1");
export const variant = process.env.RAG_EVAL_VARIANT;
if (variant && !["traditional", "agentic", "agentic-fixed"].includes(variant)) throw new Error("INVALID_EVAL_VARIANT");
export const root = variant ? join(comparisonRoot, variant) : datasetRoot;
export const codeRoot = variant === "traditional" ? resolve(comparisonRoot, "traditional-code") : repo;
