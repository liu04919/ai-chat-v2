import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Budget } from "./budget";
import { readUsage, validateEvalTools, startMeter } from "./meter";

describe("shared evaluation budget", () => {
  it("Agentic 评测只允许知识库函数，不开放联网、生图或远程会话", () => {
    const tools = [{ type: "function", name: "search_knowledge" }];
    expect(() => validateEvalTools({ tools }, true)).not.toThrow();
    expect(() => validateEvalTools({ tools })).toThrow("EVAL_DISALLOWED_TOOL");
    for (const tool of [{ type: "web_search" }, { type: "image_generation" }, { type: "function", name: "send_email" }]) {
      expect(() => validateEvalTools({ tools: [tool] }, true)).toThrow("EVAL_DISALLOWED_TOOL");
    }
    expect(() => validateEvalTools({ previous_response_id: "r" }, true)).toThrow("EVAL_STATEFUL_INPUT_FORBIDDEN");
  });
  it("不能把付费远程渠道误标为订阅渠道跳过预算", async () => {
    await expect(startMeter({} as Budget, { LLM_BASE_URL: "https://api.example.com/v1" }, {
      subscriptionLog: "unused", allowKnowledgeTool: true,
    })).rejects.toThrow("SUBSCRIPTION_REQUIRES_LOCAL_PROXY");
  });
  it("persists unsettled reservations across restarts and refuses overspend", () => {
    const dir = mkdtempSync(join(tmpdir(), "rag-budget-test-"));
    try {
      const path = join(dir, "usage.jsonl");
      const first = new Budget(path, 1);
      const settle = first.reserve("gpt-5.6-sol", 100_000, 100_000);
      expect(first.summary().accountedCny).toBeCloseTo(0.375);
      settle(100, 200);
      first.reserve("gpt-6-astra", 100_000, 100_000);
      const restarted = new Budget(path, 1);
      expect(restarted.summary().unresolved).toBe(1);
      expect(restarted.summary().accountedCny).toBeCloseTo(0.938175);
      expect(() => restarted.reserve("gpt-6-astra", 100_000, 100_000)).toThrow("BUDGET_EXHAUSTED");
      expect(() => new Budget(path, 21)).toThrow("INVALID_BUDGET");
    } finally { rmSync(dir, { recursive: true }); }
  });
  it("reads Responses, Chat Completions and DashScope usage without counting reasoning twice", () => {
    expect(readUsage({ response: { usage: { input_tokens: 100, output_tokens: 50, output_tokens_details: { reasoning_tokens: 40 } } } })).toEqual({ input: 100, output: 50 });
    expect(readUsage({ usage: { prompt_tokens: 123, completion_tokens: 45 } })).toEqual({ input: 123, output: 45 });
    expect(readUsage({ usage: { total_tokens: 321 } })).toEqual({ input: 321, output: 0 });
    expect(readUsage({})).toBeNull();
    expect(readUsage({ usage: { input_tokens: -1 } })).toBeNull();
  });
  it("preserves a token-limit breach after restart even if total cost was below reservation", () => {
    const dir = mkdtempSync(join(tmpdir(), "rag-budget-test-"));
    try {
      const path = join(dir, "usage.jsonl");
      const first = new Budget(path);
      const settle = first.reserve("gpt-5.6-sol", 100, 1000);
      expect(() => settle(101, 1)).toThrow("UPSTREAM_EXCEEDED_RESERVATION");
      const restarted = new Budget(path);
      expect(restarted.summary().halted).toBe(true);
      expect(() => restarted.reserve("gpt-5.6-sol", 1, 1)).toThrow("BUDGET_EXHAUSTED");
    } finally { rmSync(dir, { recursive: true }); }
  });
});
