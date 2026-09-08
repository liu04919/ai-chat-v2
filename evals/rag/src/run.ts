import { readFileSync, writeFileSync, appendFileSync, existsSync, openSync, closeSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import {
  knowledgeBaseSchema, knowledgeDocumentListSchema, createKnowledgeUploadResponseSchema,
  createGenerationResponseSchema, conversationDetailResponseSchema, generationEventSchema,
} from "@ai-chat/contracts";
import { sha256, type CorpusDocument, type EvalQuestion } from "./dataset";
import { root, codeRoot, variant } from "./paths";

const read = <T>(name: string): T => JSON.parse(readFileSync(join(root, name), "utf8")) as T;
const save = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value, null, 2) + "\n");
const append = (name: string, value: unknown) => appendFileSync(join(root, name), JSON.stringify(value) + "\n");
type State = { email: string; password: string; baseId?: string; documents: Record<string, string>; attempts: Record<string, { conversationId: string; userMessageId: string }> };

async function main() {
  const command = process.argv[2];
  if (!["upload", "pilot", "test"].includes(command ?? "")) throw new Error("USE_UPLOAD_PILOT_TEST");
  const runtime = read<{ webUrl: string; database: string; redisDatabase: number }>("runtime.json");
  if (runtime.webUrl !== "http://localhost:3301" || runtime.database !== "/ai_chat_eval_cmrc2018" || runtime.redisDatabase !== 14) throw new Error("UNSAFE_EVAL_RUNTIME");
  const manifest = read<{ files: Record<string, string>; chunkCount: number; split: { parserSha256: string } }>("manifest.json");
  for (const [file, hash] of Object.entries(manifest.files)) if (sha256(readFileSync(join(root, file))) !== hash) throw new Error("DATASET_HASH_MISMATCH");
  if (sha256(readFileSync(fileURLToPath(new URL("../../../apps/worker/src/knowledge/parse.ts", import.meta.url)))) !== manifest.split.parserSha256) throw new Error("PARSER_CHANGED_REPREPARE_REQUIRED");
  const lockPath = join(root, "runner.lock");
  const lock = openSync(lockPath, "wx");
  try {
    const newAccount = !existsSync(join(root, "state.json"));
    const state: State = newAccount ? { email: `rag-eval-${randomUUID()}@example.com`, password: randomUUID(), documents: {}, attempts: {} } : read<State>("state.json");
    if (newAccount) save("state.json", state);
    let cookie = "";
    async function request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
      const response = await fetch(runtime.webUrl + path, {
        method, headers: { "content-type": "application/json", origin: runtime.webUrl, ...(cookie ? { cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000), redirect: "error",
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) cookie = cookies.map((c) => c.split(";")[0]).join("; ");
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      return response.json() as Promise<unknown>;
    }
    await request(newAccount ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email", { email: state.email, password: state.password, ...(newAccount ? { name: "RAG evaluation" } : {}) });
    if (!state.baseId) {
      state.baseId = knowledgeBaseSchema.parse(await request("/api/knowledge-bases", { name: "CMRC 2018 eval only" })).id;
      save("state.json", state);
    }
    const basePath = `/api/knowledge-bases/${state.baseId}`;
    const corpus = read<CorpusDocument[]>("corpus.json");
    if (command === "upload") {
      for (const [index, document] of corpus.entries()) {
        if (state.documents[document.id]) continue;
        const bytes = readFileSync(join(root, "documents", `${document.id}.txt`));
        if (sha256(bytes) !== sha256(document.text)) throw new Error("DOCUMENT_HASH_MISMATCH");
        const { document: created, upload } = createKnowledgeUploadResponseSchema.parse(await request(basePath + "/documents", { originalName: `${document.id}.txt`, mediaType: "text/plain", sizeBytes: bytes.length }));
        // 只把文件正文交给预签名对象存储地址；绝不带网站 Cookie 或模型凭证。
        const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: bytes, redirect: "error", signal: AbortSignal.timeout(60_000) });
        if (!put.ok) throw new Error("DIRECT_UPLOAD_FAILED");
        await request(`${basePath}/documents/${created.id}/complete`, {}, "POST");
        state.documents[document.id] = created.id;
        save("state.json", state);
        if ((index + 1) % 25 === 0) console.log(`Uploaded ${index + 1}/${corpus.length}`);
      }
    }
    if (Object.keys(state.documents).length !== corpus.length) throw new Error("UPLOAD_FULL_CORPUS_FIRST");
    let ready = false;
    for (let poll = 0; poll < 1200; poll++) {
      const { documents } = knowledgeDocumentListSchema.parse(await request(basePath + "/documents"));
      if (documents.length !== corpus.length) throw new Error("CORPUS_DOCUMENT_COUNT_MISMATCH");
      if (documents.some((d) => d.status === "failed")) throw new Error("INGESTION_FAILED_INSPECT_HOST_LOG");
      const count = documents.filter((d) => d.status === "ready").length;
      if (count === corpus.length) {
        if (documents.reduce((n, d) => n + d.chunkCount, 0) !== manifest.chunkCount) throw new Error("BUSINESS_CHUNK_COUNT_MISMATCH");
        ready = true; break;
      }
      if (poll % 6 === 0) console.log(`Ingested ${count}/${corpus.length}`);
      await delay(5000);
    }
    if (!ready) throw new Error("INGESTION_WAIT_TIMEOUT");
    if (command === "upload") { console.log("Full corpus ready; business parser chunk count verified"); return; }
    const questions = read<EvalQuestion[]>(`${command}.json`);
    const filename = `${command}-answers.jsonl`;
    const previous = existsSync(join(root, filename)) ? readFileSync(join(root, filename), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id: string; ok: boolean }) : [];
    const done = new Set(previous.filter((r) => r.ok).map((r) => r.id));
    for (const q of questions) {
      if (done.has(q.id)) continue;
      const failed = previous.some((r) => r.id === q.id && !r.ok);
      if (failed && process.argv.includes("--continue-on-failure") && !process.argv.includes("--retry-failed")) continue;
      if (failed && !process.argv.includes("--retry-failed")) throw new Error("INSPECT_FAILURE_THEN_USE_RETRY_FAILED");
      if (failed) delete state.attempts[q.id];
      const resumed = Boolean(state.attempts[q.id]);
      state.attempts[q.id] ??= { conversationId: randomUUID(), userMessageId: randomUUID() };
      save("state.json", state);
      const started = performance.now();
      const ids = state.attempts[q.id];
      const generation = createGenerationResponseSchema.parse(await request("/api/generations", { target: { type: "new", conversationId: ids.conversationId, mode: "chat" }, userMessageId: ids.userMessageId, parts: [{ type: "text", text: q.question }], reasoningEffort: "medium", tools: { webSearch: false, mcpToolIds: [] }, knowledgeBaseId: state.baseId }));
      const stream = await fetch(`${runtime.webUrl}/api/generations/${generation.generation.id}/events`, { headers: { cookie }, signal: AbortSignal.timeout(240_000) });
      if (!stream.ok || !stream.body) throw new Error("SSE_FAILED");
      let pending = "", streamedText = "", terminal = "";
      let firstTextMs: number | null = null;
      let sourcesMs: number | null = null;
      const toolEvents: { elapsedMs: number; event: unknown }[] = [];
      const decoder = new TextDecoder();
      for await (const bytes of stream.body) {
        pending += decoder.decode(bytes, { stream: true });
        const lines = pending.split("\n"); pending = lines.pop()!;
        for (const line of lines) if (line.startsWith("data:")) {
          const event = generationEventSchema.parse(JSON.parse(line.slice(5)));
          if (event.type === "text.delta") { firstTextMs ??= performance.now() - started; streamedText += event.delta; }
          if (event.type === "knowledge.sources") sourcesMs ??= performance.now() - started;
          if (event.type === "tool.call" || event.type === "tool.result") toolEvents.push({ elapsedMs: performance.now() - started, event });
          if (["generation.completed", "generation.failed", "generation.cancelled"].includes(event.type)) terminal = event.type;
        }
      }
      const detail = conversationDetailResponseSchema.parse(await request(`/api/conversations/${ids.conversationId}`));
      const assistant = detail.messages.find((m) => m.role === "assistant");
      const answer = assistant?.parts.flatMap((p) => p.type === "text" ? [p.text] : []).join("") ?? "";
      const sources = assistant?.parts.flatMap((p) => p.type === "knowledge-sources" ? p.sources : []) ?? [];
      const ok = terminal === "generation.completed" && detail.latestGeneration?.status === "completed" && answer === streamedText && Boolean(answer.trim());
      append(filename, {
        id: q.id, question: q.question, referenceAnswers: q.answers.map((a) => a.text), goldDocumentId: q.documentId,
        conversationId: ids.conversationId, generationId: generation.generation.id,
        // 失败时可能没有落库回答，另留 SSE 已到达的正文用于诊断，不把它算成成功答案。
        answer, streamedText, sources, terminal, ok, toolEvents, startedAt: Date.now() - (performance.now() - started), completedAt: Date.now(), variant,
        // 断点恢复重放不是实时 TTFT，不能掺进时延统计。
        timing: resumed ? null : { firstTextMs, sourcesMs, totalMs: performance.now() - started },
        git: execFileSync("git", ["rev-parse", "HEAD"], { cwd: codeRoot, encoding: "utf8" }).trim(),
      });
      console.log(`${command} ${q.id}: ${ok ? "completed" : "failed"}`);
      if (!ok && !process.argv.includes("--continue-on-failure")) throw new Error("ANSWER_FAILED_RECORDED");
    }
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
main().catch((e: unknown) => {
  const code = e instanceof Error && /^[A-Z0-9_]+$/.test(e.message) ? e.message : "EVAL_RUN_FAILED";
  console.error(code); process.exitCode = 1;
});
