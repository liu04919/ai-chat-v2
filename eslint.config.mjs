import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    settings: {
      next: {
        rootDir: "apps/web/",
      },
    },
  },
  globalIgnores([
    "**/.next/**",
    "**/.next-rag-eval/**",
    "**/coverage/**",
    "**/dist/**",
    "**/node_modules/**",
    "**/next-env.d.ts",
    "evals/retrieval/.venv/**",
    "evals/retrieval/artifacts/**",
    "evals/rag/artifacts/**",
    "evals/rag/.venv/**",
  ]),
]);
