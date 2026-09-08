import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// 每百万 token 的人民币预算单价。输入按缓存写入最高档计，不依赖缓存折扣。
// 2026-09-08 用户截图：标准 0.12 -> 专业 0.15；保留单价来源供复查。
export const PRICES = {
  "qwen3.7-text-embedding": { input: 0.5, output: 0 },
  "qwen3.7-text-rerank": { input: 0.5, output: 0 },
  "gpt-5.6-sol": { input: 0.75, output: 3 },
  "gpt-6-astra": { input: 1.875, output: 7.5 },
} as const;
type Entry = { id: string; model: keyof typeof PRICES; reserved: number; actual?: number; input?: number; output?: number; exceeded?: boolean; at: string };

export class Budget {
  private entries = new Map<string, Entry>();
  private halted = false;
  constructor(private path: string, readonly limit = 20) {
    if (!Number.isFinite(limit) || limit <= 0 || limit > 20) throw new Error("INVALID_BUDGET");
    if (existsSync(path)) for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
      const entry = JSON.parse(line) as Entry;
      this.entries.set(entry.id, entry);
      if (entry.exceeded || (entry.actual !== undefined && entry.actual > entry.reserved)) this.halted = true;
    }
  }
  summary() {
    const values = [...this.entries.values()];
    return { limitCny: this.limit, accountedCny: values.reduce((n, e) => n + (e.actual ?? e.reserved), 0), requests: values.length, unresolved: values.filter((e) => e.actual === undefined).length, halted: this.halted, pricesCnyPerMillion: PRICES };
  }
  reserve(model: keyof typeof PRICES, input: number, output: number) {
    if (![input, output].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error("INVALID_RESERVATION");
    const rates = PRICES[model];
    if (!rates) throw new Error("UNPRICED_MODEL");
    const reserved = (input * rates.input + output * rates.output) / 1e6;
    if (this.halted || this.summary().accountedCny + reserved > this.limit) throw new Error("BUDGET_EXHAUSTED");
    const entry: Entry = { id: randomUUID(), model, reserved, at: new Date().toISOString() };
    this.save(entry);
    let settled = false;
    return (actualInput: number, actualOutput: number) => {
      if (settled) throw new Error("ALREADY_SETTLED");
      if (![actualInput, actualOutput].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error("INVALID_USAGE");
      settled = true;
      const actual = (actualInput * rates.input + actualOutput * rates.output) / 1e6;
      const exceeded = actualInput > input || actualOutput > output || actual > reserved;
      this.save({ ...entry, actual, input: actualInput, output: actualOutput, exceeded });
      if (exceeded) {
        this.halted = true;
        throw new Error("UPSTREAM_EXCEEDED_RESERVATION");
      }
    };
  }
  private save(entry: Entry) {
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
    this.entries.set(entry.id, entry);
  }
}
