import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Budget, evaluationDatabaseUrl, upperTokens } from "./support";
import { knowledgeSearchQueries } from "../../../packages/db/src/knowledge-search";
import { PgDialect } from "drizzle-orm/pg-core";

describe("离线评测边界", () => {
  it("拒绝业务库、远程库和不安全名称", () => {
    for (const url of [
      undefined,
      "postgres://localhost/ai_chat",
      "postgres://remote/ai_chat_eval_test",
      "postgres://localhost/ai_chat_eval_a-b",
    ])
      expect(() => evaluationDatabaseUrl(url, undefined)).toThrow();
    const url = "postgres://localhost/ai_chat_eval_test";
    expect(() => evaluationDatabaseUrl(url, url)).toThrow(
      "EVAL_DATABASE_IS_BUSINESS_DATABASE",
    );
    expect(
      evaluationDatabaseUrl(url, "postgres://localhost/ai_chat").pathname,
    ).toBe("/ai_chat_eval_test");
  });
  it("预算先预留再调用，失败与重启不能重新获得额度", () => {
    const directory = mkdtempSync(join(tmpdir(), "rag-eval-budget-"));
    try {
      const path = join(directory, "usage.jsonl");
      const budget = new Budget(path, 1);
      const settle = budget.reserve("embedding", 1_000_000);
      expect(budget.usedCny).toBe(0.5);
      settle(200_000);
      expect(budget.usedCny).toBe(0.1);
      budget.reserve("unknown-usage", 1_000_000);
      const resumed = new Budget(path, 1);
      expect(resumed.usedCny).toBe(0.6);
      expect(resumed.summary().unresolvedRequests).toBe(1);
      expect(() => resumed.reserve("over-budget", 1_000_000)).toThrow(
        "EVAL_BUDGET_EXHAUSTED",
      );
      expect(() => new Budget(path, 21)).toThrow("INVALID_BUDGET");
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
  it("预算按 UTF-8 字节留余量；共享 SQL 默认 30，可显式设为 50", () => {
    expect(upperTokens(["中文"])).toBe(262);
    expect(upperTokens(["中文"], "问题")).toBe(4108);
    const dialect = new PgDialect();
    const args: [string, string, string, number[], string] = [
      "owner",
      "base",
      "问题",
      [1],
      "model",
    ];
    const queries = knowledgeSearchQueries(...args);
    expect(dialect.sqlToQuery(queries.semantic).params).toContain(30);
    const configured = knowledgeSearchQueries(...args, 50);
    expect(dialect.sqlToQuery(configured.lexical).params).toContain(50);
    for (const limit of [0, -1, 0.5, 101, NaN])
      expect(() => knowledgeSearchQueries(...args, limit)).toThrow(
        "INVALID_CANDIDATE_LIMIT",
      );
  });
});
