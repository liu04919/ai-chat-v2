import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { Budget, PRICES } from "./budget";

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value !== null && typeof value === "object" ? value as Json : {};

export function readUsage(value: unknown): { input: number; output: number } | null {
  const root = object(value);
  const usage = object(root.usage ?? object(root.response).usage);
  const input = usage.input_tokens ?? usage.prompt_tokens ?? usage.total_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0;
  return typeof input === "number" && typeof output === "number" && Number.isSafeInteger(input) && Number.isSafeInteger(output) && input >= 0 && output >= 0 ? { input, output } : null;
}

export function validateEvalTools(body: Json, allowKnowledgeTool = false) {
  if (body.previous_response_id || body.conversation) throw new Error("EVAL_STATEFUL_INPUT_FORBIDDEN");
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((tool) => {
    const item = object(tool);
    return !allowKnowledgeTool || item.type !== "function" || item.name !== "search_knowledge";
  }))) throw new Error("EVAL_DISALLOWED_TOOL");
}

export async function startMeter(budget: Budget, env: NodeJS.ProcessEnv, options?: {
  subscriptionLog: string;
  allowKnowledgeTool: boolean;
}) {
  if (options) {
    const base = new URL(env.LLM_BASE_URL!);
    if (base.origin !== "http://127.0.0.1:8080" || base.pathname !== "/v1") throw new Error("SUBSCRIPTION_REQUIRES_LOCAL_PROXY");
  }
  const token = randomUUID();
  const route = {
    "/llm/responses": { base: env.LLM_BASE_URL, key: env.LLM_API_KEY, suffix: "/responses", models: ["gpt-5.6-sol", "gpt-6-astra"] },
    "/llm/chat/completions": { base: env.LLM_BASE_URL, key: env.LLM_API_KEY, suffix: "/chat/completions", models: ["gpt-6-astra"] },
    "/embedding/embeddings": { base: env.EMBEDDING_BASE_URL, key: env.DASHSCOPE_API_KEY, suffix: "/embeddings", models: ["qwen3.7-text-embedding"] },
    "/rerank/services/rerank/text-rerank/text-rerank": { base: env.RERANK_BASE_URL, key: env.DASHSCOPE_API_KEY, suffix: "/services/rerank/text-rerank/text-rerank", models: ["qwen3.7-text-rerank"] },
  };
  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    const requestId = randomUUID();
    let subscription: Json | undefined;
    try {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
      if (req.url === "/budget" && req.method === "GET") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(budget.summary())); return; }
      const target = route[req.url as keyof typeof route];
      if (req.method !== "POST" || !target?.base || !target.key) throw new Error("DISALLOWED_ENDPOINT");
      const parts: Buffer[] = [];
      let size = 0;
      for await (const part of req) {
        size += part.length;
        if (size > 2_000_000) throw new Error("REQUEST_TOO_LARGE");
        parts.push(Buffer.from(part));
      }
      const body = JSON.parse(Buffer.concat(parts).toString("utf8")) as Json;
      const model = String(body.model) as keyof typeof PRICES;
      if (!target.models.includes(model)) throw new Error("DISALLOWED_MODEL");
      let output = 0;
      if (req.url?.startsWith("/llm/")) {
        validateEvalTools(body, options?.allowKnowledgeTool);
        output = 8192;
        if (req.url.endsWith("responses")) body.max_output_tokens = output;
        else { delete body.max_tokens; body.max_completion_tokens = output; }
      }
      const encoded = JSON.stringify(body);
      // UTF-8 字节数加包装余量为输入预留；精排 query 对每个候选重复计费。
      const candidates = object(body.input).documents;
      const repeat = Array.isArray(candidates) ? candidates.length : 1;
      const input = Buffer.byteLength(encoded) + repeat * (4096 + Buffer.byteLength(String(object(body.input).query ?? "")));
      // Codex 订阅用量单独记录，不按旧中转人民币价格计费；付费检索仍逐笔预留。
      if (options && req.url?.startsWith("/llm/")) {
        subscription = { requestId, model, startedAt, inputBytes: Buffer.byteLength(encoded), outputTokenCap: output, reasoning: body.reasoning, usage: null };
        appendFileSync(options.subscriptionLog, JSON.stringify({ ...subscription, state: "started" }) + "\n");
      }
      const settle = subscription ? undefined : budget.reserve(model, input, output);
      const abort = new AbortController();
      res.on("close", () => { if (!res.writableEnded) abort.abort(); });
      const response = await fetch(target.base.replace(/\/$/, "") + target.suffix, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${target.key}` },
        body: encoded, redirect: "error", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(180_000)]),
      });
      if (!response.ok || !response.body) throw new Error(`UPSTREAM_HTTP_${response.status}`);
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
      const streaming = response.headers.get("content-type")?.includes("text/event-stream");
      const decoder = new TextDecoder();
      let pending = "";
      let usage: ReturnType<typeof readUsage> = null;
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        if (streaming) {
          const lines = pending.split("\n");
          pending = lines.pop()!;
          for (const line of lines) if (line.startsWith("data:") && line.slice(5).trim() !== "[DONE]") {
            try { usage = readUsage(JSON.parse(line.slice(5))) ?? usage; } catch { /* 非 JSON 心跳不计用量 */ }
          }
        }
        if (!res.write(chunk)) await once(res, "drain");
      }
      pending += decoder.decode();
      if (!streaming) usage = readUsage(JSON.parse(pending));
      if (usage) settle?.(usage.input, usage.output);
      if (subscription && options) appendFileSync(options.subscriptionLog, JSON.stringify({ ...subscription, state: "completed", usage, completedAt: Date.now() }) + "\n");
      // 无 usage / 超时 / 失败保留整笔预留，绝不把未知费用当 0。
      res.end();
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "UPSTREAM_TRANSPORT_OR_PARSE_FAILED";
      if (subscription && options) appendFileSync(options.subscriptionLog, JSON.stringify({ ...subscription, state: "failed", error: code, completedAt: Date.now() }) + "\n");
      console.error(`Evaluation meter: ${code}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: code, type: "eval_error" } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("METER_LISTEN_FAILED");
  return { url: `http://127.0.0.1:${address.port}`, token, close: () => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())) };
}
