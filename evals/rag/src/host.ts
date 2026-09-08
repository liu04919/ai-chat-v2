import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { createDatabase, migrateDatabase } from "@ai-chat/db";
import IORedis from "ioredis";
import { evaluationDatabaseUrl } from "../../retrieval/src/support";
import { Budget } from "./budget";
import { startMeter } from "./meter";
import { root, repo, codeRoot, datasetRoot, comparisonRoot, variant } from "./paths";

const children: ChildProcess[] = [];
const logHandles: number[] = [];
const webUrl = "http://localhost:3301";

async function main() {
  if (!existsSync(join(root, "manifest.json"))) throw new Error("PREPARE_DATA_FIRST");
  const lockPath = join(datasetRoot, "host.lock");
  const lock = openSync(lockPath, "wx");
  const business = { ...parseEnv(readFileSync(join(repo, "apps/web/.env.local"), "utf8")), ...process.env };
  const dbUrl = new URL(business.DATABASE_URL!);
  dbUrl.pathname = "/ai_chat_eval_cmrc2018";
  evaluationDatabaseUrl(dbUrl.toString(), business.DATABASE_URL);
  const redisUrl = new URL(business.REDIS_URL!);
  if (!["localhost", "127.0.0.1"].includes(redisUrl.hostname)) throw new Error("LOCAL_REDIS_REQUIRED");
  if (redisUrl.pathname === "/14") throw new Error("EVAL_REDIS_IS_BUSINESS_REDIS");
  redisUrl.pathname = "/14";
  const redis = new IORedis(redisUrl.toString(), { maxRetriesPerRequest: 1 });
  const marker = "ai-chat:rag-eval:cmrc2018";
  const size = await redis.dbsize();
  if (size && await redis.get(marker) !== "v1") throw new Error("EVAL_REDIS_NOT_EMPTY");
  await redis.set(marker, "v1");
  await redis.quit();
  const adminUrl = new URL(dbUrl); adminUrl.pathname = "/postgres";
  const admin = createDatabase(adminUrl.toString(), 1);
  try {
    if (!(await admin.client`SELECT 1 FROM pg_database WHERE datname = 'ai_chat_eval_cmrc2018'`).length)
      await admin.client.unsafe('CREATE DATABASE "ai_chat_eval_cmrc2018"');
  } finally { await admin.close(); }
  await migrateDatabase({ databaseUrl: dbUrl.toString(), migrationsFolder: join(repo, "packages/db/drizzle") });
  const budget = new Budget(join(variant ? comparisonRoot : root, "usage.jsonl"), variant ? 10 : 20);
  const meter = await startMeter(budget, business, variant ? {
    subscriptionLog: join(root, "subscription-usage.jsonl"),
    allowKnowledgeTool: variant === "agentic" || variant === "agentic-fixed",
  } : undefined);
  const secretPath = join(root, "auth-secret.txt");
  const authSecret = existsSync(secretPath) ? readFileSync(secretPath, "utf8") : randomUUID() + randomUUID();
  if (!existsSync(secretPath)) writeFileSync(secretPath, authSecret);
  const env = {
    ...business, DATABASE_URL: dbUrl.toString(), REDIS_URL: redisUrl.toString(),
    BETTER_AUTH_URL: webUrl, BETTER_AUTH_SECRET: authSecret, RAG_EVAL_INSTANCE: "1",
    LLM_BASE_URL: meter.url + "/llm", LLM_API_KEY: meter.token, LLM_MODEL: "gpt-5.6-sol",
    EMBEDDING_BASE_URL: meter.url + "/embedding", DASHSCOPE_API_KEY: meter.token,
    RERANK_BASE_URL: meter.url + "/rerank",
    // 评测不调用图片和外部工具，避免越过费用控制入口。
    IMAGE_API_KEY: "", TAVILY_API_KEY: "",
  };
  function start(name: string, args: string[], cwd: string) {
    const fd = openSync(join(root, `${name}.log`), "a"); logHandles.push(fd);
    const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ["ignore", fd, fd] });
    children.push(child);
    child.on("exit", () => { if (!stopping) void shutdown(); });
  }
  let stopping = false;
  async function shutdown() {
    if (stopping) return; stopping = true;
    for (const child of children) if (child.pid && child.exitCode === null) {
      if (process.platform === "win32") { try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {} }
      else child.kill("SIGTERM");
    }
    await meter.close();
    writeFileSync(join(root, "cost.json"), JSON.stringify(budget.summary(), null, 2));
    for (const fd of logHandles) closeSync(fd);
    closeSync(lock); unlinkSync(lockPath);
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  start("web", [join(codeRoot, "apps/web/node_modules/next/dist/bin/next"), "dev", "--port", "3301"], join(codeRoot, "apps/web"));
  start("worker", ["--import", pathToFileURL(join(codeRoot, "node_modules/tsx/dist/loader.mjs")).href, "--use-env-proxy", join(codeRoot, "apps/worker/src/index.ts")], codeRoot);
  writeFileSync(join(root, "runtime.json"), JSON.stringify({ webUrl, meterUrl: meter.url, meterToken: meter.token, pid: process.pid, database: dbUrl.pathname, redisDatabase: 14, outputTokenCap: 8192, variant, codeRoot }, null, 2));
  console.log(`RAG eval host: localhost:3301; isolated DB / Redis 14; ${variant ?? "legacy"}; CNY limit ${budget.limit}`);
}
main().catch(() => { console.error("EVAL_HOST_START_FAILED"); process.exitCode = 1; });
