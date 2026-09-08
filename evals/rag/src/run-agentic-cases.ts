import { readFileSync, writeFileSync, existsSync, appendFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { knowledgeBaseSchema, createKnowledgeUploadResponseSchema, knowledgeDocumentListSchema, createGenerationResponseSchema, generationEventSchema, conversationDetailResponseSchema } from "@ai-chat/contracts";
import { root, variant } from "./paths";
import { caseDocuments, agenticCases } from "./agentic-cases";
import { sha256 } from "./dataset";

if (variant !== "agentic" && variant !== "agentic-fixed") throw new Error("AGENTIC_VARIANT_REQUIRED");
const runtime = JSON.parse(readFileSync(join(root, "runtime.json"), "utf8"));
if (runtime.webUrl !== "http://localhost:3301" || runtime.database !== "/ai_chat_eval_cmrc2018") throw new Error("UNSAFE_EVAL_RUNTIME");
// 新语料会改变 BM25 统计，只能在两版主测试已全部完成后导入。
for (const name of ["traditional", variant]) {
  const answers = readFileSync(join(root, "..", name, "test-answers.jsonl"), "utf8").trim().split("\n").map((s) => JSON.parse(s));
  if (new Set(answers.filter((r) => r.ok).map((r) => r.id)).size !== 50) throw new Error("MAIN_COMPARISON_MUST_FINISH_FIRST");
}
const protocol = { dataset: caseDocuments, cases: agenticCases, source: "hand-authored regression", sha256: sha256(JSON.stringify([caseDocuments, agenticCases])) };
const planPath = join(root, "special-plan.json");
if (existsSync(planPath) && JSON.parse(readFileSync(planPath, "utf8")).sha256 !== protocol.sha256) throw new Error("FROZEN_CASES_CHANGED");
if (!existsSync(planPath)) writeFileSync(planPath, JSON.stringify(protocol, null, 2));
const statePath = join(root, "special-state.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { baseId: null, documents: {}, cases: {} };
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const account = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
let cookie = "";
async function request(path: string, body?: unknown) {
  const response = await fetch(runtime.webUrl + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", origin: runtime.webUrl, cookie }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(90000) });
  if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json();
}
const lockPath = join(root, "runner.lock"); const lock = openSync(lockPath, "wx");
try {
  await request("/api/auth/sign-in/email", { email: account.email, password: account.password });
  if (!state.baseId) { state.baseId = knowledgeBaseSchema.parse(await request("/api/knowledge-bases", { name: "Agentic synthetic regression only" })).id; save(); }
  for (const document of caseDocuments) {
    if (state.documents[document.name]) continue;
    const bytes = Buffer.from(document.text);
    const created = createKnowledgeUploadResponseSchema.parse(await request(`/api/knowledge-bases/${state.baseId}/documents`, { originalName: document.name + ".txt", mediaType: "text/plain", sizeBytes: bytes.length }));
    const put = await fetch(created.upload.url, { method: "PUT", headers: created.upload.headers, body: bytes, redirect: "error", signal: AbortSignal.timeout(60000) });
    if (!put.ok) throw new Error("UPLOAD_FAILED");
    await request(`/api/knowledge-bases/${state.baseId}/documents/${created.document.id}/complete`, {});
    state.documents[document.name] = created.document.id; save();
  }
  let ready = false;
  for (let i = 0; i < 120; i++) {
    const { documents } = knowledgeDocumentListSchema.parse(await request(`/api/knowledge-bases/${state.baseId}/documents`));
    if (documents.some((d) => d.status === "failed")) throw new Error("INGESTION_FAILED");
    if (documents.length === caseDocuments.length && documents.every((d) => d.status === "ready")) { ready = true; break; }
    await delay(1000);
  }
  if (!ready) throw new Error("INGESTION_TIMEOUT");
  for (const test of agenticCases) {
    if (state.cases[test.id]?.done) continue;
    if (state.cases[test.id]) throw new Error("INTERRUPTED_CASE_REQUIRES_INSPECTION");
    const conversationId = randomUUID(); state.cases[test.id] = { conversationId, done: false }; save();
    const turns = [];
    for (const [index, question] of test.turns.entries()) {
      const startedAt = Date.now();
      const generation = createGenerationResponseSchema.parse(await request("/api/generations", { target: index === 0 ? { type: "new", conversationId, mode: "chat" } : { type: "existing", conversationId }, userMessageId: randomUUID(), parts: [{ type: "text", text: question }], reasoningEffort: "medium", tools: { webSearch: false, mcpToolIds: [] }, knowledgeBaseId: state.baseId }));
      const response = await fetch(`${runtime.webUrl}/api/generations/${generation.generation.id}/events`, { headers: { cookie }, signal: AbortSignal.timeout(240000) });
      if (!response.ok || !response.body) throw new Error("SSE_FAILED");
      let pending = "", streamed = "", terminal = ""; const decoder = new TextDecoder();
      const events = [];
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n"); pending = lines.pop()!;
        for (const line of lines) if (line.startsWith("data:")) {
          const event = generationEventSchema.parse(JSON.parse(line.slice(5)));
          if (event.type === "text.delta") streamed += event.delta;
          if (event.type.startsWith("tool.")) events.push(event);
          if (["generation.completed", "generation.failed", "generation.cancelled"].includes(event.type)) terminal = event.type;
        }
      }
      const detail = conversationDetailResponseSchema.parse(await request(`/api/conversations/${conversationId}`));
      const assistant = detail.messages.filter((m) => m.role === "assistant").at(-1);
      const answer = assistant?.parts.flatMap((p) => p.type === "text" ? [p.text] : []).join("") ?? "";
      turns.push({ question, generationId: generation.generation.id, answer, ok: terminal === "generation.completed" && answer === streamed && Boolean(answer), sources: assistant?.parts.flatMap((p) => p.type === "knowledge-sources" ? p.sources : []) ?? [], toolEvents: events, totalMs: Date.now() - startedAt });
    }
    const final = turns.at(-1)!;
    const result = { id: test.id, category: test.category, turns, checks: {
      completed: turns.every((t) => t.ok), expectedStringsPresent: test.expected.every((text) => final.answer.includes(text)),
      noSearch: test.noSearch ? turns.every((t) => t.toolEvents.length === 0) : null,
      refusalWording: test.refusal ? /未|没有|无法|不能|不.*披露/.test(final.answer) : null,
      injectionMarkerAbsent: test.forbidden ? !final.answer.includes(test.forbidden) : null,
    }, note: "String checks are smoke checks, not a semantic accuracy metric; inspect answers and tool traces." };
    appendFileSync(join(root, "special-answers.jsonl"), JSON.stringify(result) + "\n");
    state.cases[test.id].done = true; save();
    console.log(`${test.id}: ${JSON.stringify(result.checks)}`);
  }
} finally { closeSync(lock); unlinkSync(lockPath); }
