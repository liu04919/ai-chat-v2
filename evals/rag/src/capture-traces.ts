import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { createDatabase } from "@ai-chat/db";
import type { AssistantMessagePartsDto } from "@ai-chat/contracts";
import { evaluationDatabaseUrl } from "../../retrieval/src/support";
import { root, repo, variant } from "./paths";

if (!variant) throw new Error("COMPARISON_VARIANT_REQUIRED");
const business = parseEnv(readFileSync(join(repo, "apps/web/.env.local"), "utf8"));
const dbUrl = new URL(business.DATABASE_URL!); dbUrl.pathname = "/ai_chat_eval_cmrc2018";
evaluationDatabaseUrl(dbUrl.toString(), business.DATABASE_URL);
const database = createDatabase(dbUrl.toString(), 1);
try {
  for (const split of ["pilot", "test", "special"]) {
    const file = join(root, `${split}-answers.jsonl`);
    if (!existsSync(file)) continue;
    const raw = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const specialState = split === "special" ? JSON.parse(readFileSync(join(root, "special-state.json"), "utf8")) : null;
    const rows = split === "special" ? raw.flatMap((row) => row.turns.map((turn: { generationId: string }, index: number) => ({ id: `${row.id}:${index}`, generationId: turn.generationId, conversationId: specialState.cases[row.id].conversationId }))) : raw;
    const result = [];
    for (const row of rows) {
      // 仅查询本次评测已记录的 Generation，不扫描业务账户或其他会话。
      const records = await database.client<{ parts: AssistantMessagePartsDto }[]>`
        SELECT m.parts FROM generations g JOIN messages m ON m.id = g.assistant_message_id
        WHERE g.id = ${row.generationId} AND g.conversation_id = ${row.conversationId}`;
      const parts = records[0]?.parts ?? [];
      const calls = parts.filter((part) => part.type === "tool-call");
      const results = parts.filter((part) => part.type === "tool-result");
      result.push({ id: row.id, generationId: row.generationId, persistedAssistant: Boolean(records[0]), calls: calls.map((call) => ({
        name: call.toolName, callId: call.toolCallId, input: call.input,
        result: results.find((r) => r.toolCallId === call.toolCallId),
      })) });
    }
    writeFileSync(join(root, `${split}-tools.json`), JSON.stringify(result, null, 2));
    console.log(`${variant} ${split}: captured ${result.length} generation traces`);
  }
} finally { await database.close(); }
