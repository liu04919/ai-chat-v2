import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
export function appendJson(path: string, value: unknown) {
  appendFileSync(path, JSON.stringify(value) + "\n");
}

export function evaluationDatabaseUrl(
  value: string | undefined,
  businessUrl: string | undefined,
) {
  if (!value) throw new Error("SET_EVAL_DATABASE_URL");
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/ai_chat_eval_[a-z0-9_]+$/.test(url.pathname)
  )
    throw new Error("UNSAFE_EVAL_DATABASE");
  if (businessUrl && new URL(businessUrl).pathname === url.pathname)
    throw new Error("EVAL_DATABASE_IS_BUSINESS_DATABASE");
  return url;
}

// UTF-8 字节数作为保守 token 预留，加上请求包装余量。未知用量/失败不退预留。
// 预算属于整个 artifacts 目录，重启不会重新获得 20 元；不依赖免费额度。
export function upperTokens(texts: string[], query?: string) {
  return texts.reduce(
    (sum, text) =>
      sum +
      Buffer.byteLength(text) +
      (query === undefined ? 256 : Buffer.byteLength(query) + 4096),
    0,
  );
}
type Charge = {
  id: string;
  kind: string;
  reservedCny: number;
  actualCny?: number;
  tokens?: number;
  at: string;
};
export class Budget {
  private entries = new Map<string, Charge>();
  constructor(
    private path: string,
    readonly limitCny: number,
  ) {
    if (!Number.isFinite(limitCny) || limitCny <= 0 || limitCny > 20)
      throw new Error("INVALID_BUDGET");
    for (const entry of readJsonl<Charge>(path))
      this.entries.set(entry.id, entry);
  }
  get usedCny() {
    return [...this.entries.values()].reduce(
      (sum, x) => sum + (x.actualCny ?? x.reservedCny),
      0,
    );
  }
  reserve(kind: string, tokens: number) {
    if (!Number.isSafeInteger(tokens) || tokens <= 0)
      throw new Error("INVALID_TOKEN_RESERVATION");
    const charge: Charge = {
      id: randomUUID(),
      kind,
      reservedCny: (tokens * 0.5) / 1_000_000,
      at: new Date().toISOString(),
    };
    if (this.usedCny + charge.reservedCny > this.limitCny)
      throw new Error("EVAL_BUDGET_EXHAUSTED");
    appendJson(this.path, charge);
    this.entries.set(charge.id, charge);
    return (actualTokens: number) => {
      if (!Number.isSafeInteger(actualTokens) || actualTokens < 0)
        throw new Error("INVALID_USAGE");
      const settled = {
        ...charge,
        actualCny: (actualTokens * 0.5) / 1_000_000,
        tokens: actualTokens,
      };
      appendJson(this.path, settled);
      this.entries.set(charge.id, settled);
      if (actualTokens > tokens) throw new Error("TOKEN_RESERVATION_EXCEEDED");
    };
  }
  summary() {
    const entries = [...this.entries.values()];
    return {
      limitCny: this.limitCny,
      accountedCny: this.usedCny,
      actualTokens: entries.reduce((n, x) => n + (x.tokens ?? 0), 0),
      unresolvedRequests: entries.filter((x) => x.actualCny === undefined)
        .length,
      pricing:
        "CNY 0.5 / million input tokens, Beijing, both models; no free quota assumed",
    };
  }
}
