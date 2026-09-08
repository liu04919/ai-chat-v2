import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { comparisonRoot, repo, variant } from "./paths";
import { sha256, type EvalQuestion } from "./dataset";
import type { KnowledgeSourceDto } from "@ai-chat/contracts";
import { Budget } from "./budget";
import { mean, percentile, pairedInterval } from "./paired-metrics";

type Answer = { id: string; question: string; generationId: string; answer: string; ok: boolean; sources: KnowledgeSourceDto[]; startedAt: number; completedAt: number; timing: { firstTextMs: number | null; totalMs: number } | null; toolEvents: { event: { type: string } }[] };
type Score = { id: string; answerSha256: string; judge: string; faithfulness: number; answer_accuracy: number };
const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8"));
const lines = <T>(path: string): T[] => readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

const plan = read<Record<string, unknown>>(join(comparisonRoot, "plan.json"));
const agenticVariant = variant === "agentic-fixed" ? "agentic-fixed" : "agentic";
if (agenticVariant === "agentic-fixed") plan.agenticRevision = read(join(comparisonRoot, agenticVariant, "revision.json"));
const questions = read<EvalQuestion[]>(join(comparisonRoot, agenticVariant, "test.json"));
const chunks = read<{ documentId: string; content: string; start: number; end: number }[]>(join(comparisonRoot, agenticVariant, "chunks.json"));
const variants = Object.fromEntries(["traditional", agenticVariant].map((variant) => {
  const dir = join(comparisonRoot, variant);
  const attempts = lines<Answer>(join(dir, "test-answers.jsonl"));
  const answers = new Map(attempts.map((r) => [r.id, r]));
  const scores = new Map(lines<Score>(join(dir, "test-scores.jsonl")).map((r) => [r.id, r]));
  if (answers.size !== 50 || scores.size !== 50) throw new Error("COMPLETE_COMPARISON_REQUIRED");
  const usage = new Map(lines<{ requestId: string; model: string; state: string; usage: { input: number; output: number } | null; startedAt: number }>(join(dir, "subscription-usage.jsonl")).map((r) => [r.requestId, r]));
  const rows = questions.map((q) => {
    const answer = answers.get(q.id), score = scores.get(q.id);
    if (!answer?.ok || !score || score.judge !== "gpt-6-astra" || score.answerSha256 !== sha256(answer.answer)) throw new Error("SCORE_OR_ANSWER_MISMATCH");
    const hit = answer.sources.some((s) => s.originalName === `${q.documentId}.txt` && chunks.some((c) => c.documentId === q.documentId && c.content === s.content && q.answers.some((a) => c.start <= a.start && c.end >= a.end)));
    const calls = [...usage.values()].filter((r) => r.model === "gpt-5.6-sol" && r.startedAt >= answer.startedAt - 5 && r.startedAt <= answer.completedAt);
    const citations = [...answer.answer.matchAll(/\[(\d+)\]\(#knowledge-(\d+)\)/g)];
    return {
      id: q.id, question: q.question, reference: q.answers[0]!.text, referenceAnswers: q.answers.map((a) => a.text), answer: answer.answer,
      accuracy: score.answer_accuracy, faithfulness: score.faithfulness, evidenceHit: Number(hit), sourceCount: answer.sources.length,
      knowledgeCalls: answer.toolEvents.filter((r) => r.event.type === "tool.call").length,
      modelCalls: calls.length, unknownUsage: calls.filter((r) => !r.usage).length,
      inputTokens: calls.reduce((n, r) => n + (r.usage?.input ?? 0), 0), outputTokens: calls.reduce((n, r) => n + (r.usage?.output ?? 0), 0),
      citationCount: citations.length, validCitations: citations.filter((m) => m[1] === m[2] && answer.sources.some((s) => s.number === Number(m[1]))).length,
      timing: answer.timing,
    };
  });
  const first = new Map<string, Answer>(); for (const row of attempts) if (!first.has(row.id)) first.set(row.id, row);
  // 总成本含失败后补跑的所有请求；逐题质量/时延仍对应最后一次成功回答。
  const allCalls = [...usage.values()].filter((call) => call.model === "gpt-5.6-sol" && attempts.some((attempt) => call.startedAt >= attempt.startedAt - 5 && call.startedAt <= attempt.completedAt));
  return [variant, { summary: {
    sampleCount: rows.length, firstAttemptCompleted: [...first.values()].filter((r) => r.ok).length, attempts: attempts.length,
    answerAccuracy: mean(rows.map((r) => r.accuracy)), faithfulness: mean(rows.map((r) => r.faithfulness)), evidenceHit: mean(rows.map((r) => r.evidenceHit)),
    sourcesMean: mean(rows.map((r) => r.sourceCount)), knowledgeCallsMean: mean(rows.map((r) => r.knowledgeCalls)), modelCalls: allCalls.length,
    inputTokens: allCalls.reduce((n, r) => n + (r.usage?.input ?? 0), 0), outputTokens: allCalls.reduce((n, r) => n + (r.usage?.output ?? 0), 0), unknownUsage: allCalls.filter((r) => !r.usage).length,
    validCitations: rows.reduce((n, r) => n + r.validCitations, 0), citationCount: rows.reduce((n, r) => n + r.citationCount, 0),
    firstTextP50Ms: percentile(rows.flatMap((r) => r.timing?.firstTextMs == null ? [] : [r.timing.firstTextMs]), 0.5),
    totalP50Ms: percentile(rows.flatMap((r) => r.timing ? [r.timing.totalMs] : []), 0.5),
    totalP95Ms: percentile(rows.flatMap((r) => r.timing ? [r.timing.totalMs] : []), 0.95),
  }, rows }];
}));
const traditional = variants.traditional!, agentic = variants[agenticVariant]!;
const paired = questions.map((q) => {
  const a = agentic.rows.find((r) => r.id === q.id)!, t = traditional.rows.find((r) => r.id === q.id)!;
  return { id: q.id, accuracyDelta: a.accuracy - t.accuracy, faithfulnessDelta: a.faithfulness - t.faithfulness };
});
const comparison = { accuracyDelta: mean(paired.map((r) => r.accuracyDelta)), accuracyDeltaCI95: pairedInterval(paired.map((r) => r.accuracyDelta)), faithfulnessDelta: mean(paired.map((r) => r.faithfulnessDelta)), faithfulnessDeltaCI95: pairedInterval(paired.map((r) => r.faithfulnessDelta)), improved: paired.filter((r) => r.accuracyDelta > 0).length, tied: paired.filter((r) => r.accuracyDelta === 0).length, worse: paired.filter((r) => r.accuracyDelta < 0).length };
const report = { plan, agenticVariant, variants, comparison, retrievalBudget: new Budget(join(comparisonRoot, "usage.jsonl"), 10).summary() };
const dest = process.argv.includes("--publish") ? join(repo, "evals/rag/reports/agentic-v1", agenticVariant) : join(comparisonRoot, agenticVariant);
mkdirSync(dest, { recursive: true });
copyFileSync(join(comparisonRoot, agenticVariant, "ATTRIBUTION.md"), join(dest, "ATTRIBUTION.md"));
writeFileSync(join(dest, "comparison.json"), JSON.stringify(report, null, 2));
const metrics = ["firstAttemptCompleted", "attempts", "answerAccuracy", "faithfulness", "evidenceHit", "sourcesMean", "knowledgeCallsMean", "modelCalls", "inputTokens", "outputTokens", "unknownUsage", "firstTextP50Ms", "totalP50Ms", "totalP95Ms"] as const;
const md = `# 同渠道传统 RAG 与 Agentic RAG 对比\n\n50 道固定 CMRC 回归题、完整 848 篇候选原文；不是官方榜单。传统基线 7134eb0，Agentic 基线 ${plan.agenticCommit}。两边 Sol / medium、同一本地 Proxy、每次模型输出上限 8192 token。Astra / low 用 Ragas 0.4.3 原始提示与算法评分。\n\n| 指标 | 传统 | Agentic |\n| --- | ---: | ---: |\n${metrics.map((key) => `| ${key} | ${traditional.summary[key]} | ${agentic.summary[key]} |`).join("\n")}\n\n## 配对差异\n\nAgentic 减传统：AnswerAccuracy ${comparison.accuracyDelta}，配对 bootstrap 95% CI ${JSON.stringify(comparison.accuracyDeltaCI95)}；Faithfulness ${comparison.faithfulnessDelta}，95% CI ${JSON.stringify(comparison.faithfulnessDeltaCI95)}。正确性评分提高/持平/下降：${comparison.improved}/${comparison.tied}/${comparison.worse}。\n\n## 口径\n\nAnswerAccuracy 不是答对比例；Faithfulness 衡量累计检索资料对整段回答的支持，不等于每个引用都正确。evidenceHit 仅检查已知答案区间是否出现在累计来源中；Agentic 可多次检索，不能把此数当单次 Recall@6 或 MRR@6。工具调用次数、全部模型调用的 token 和延迟同时报告；订阅 token 无人民币折算，缺失 usage 不当作零。\n\n旧测试集已被检查，因此这是固定回归比较，不是全新盲测集。两种方案分批执行，共享渠道负载/缓存与模型随机性影响延迟；单次生成、50 题不能证明普遍提升。额外专项为手工构造回归案例，另行报告。原始问题、回答、逐题分数见 comparison.json。\n\n付费检索预算计入金额 ¥${report.retrievalBudget.accountedCny.toFixed(6)} / ¥10，未结算请求 ${report.retrievalBudget.unresolved}；这是按用量保守估计，不是供应商账单。\n`;
const revisionNote = plan.agenticRevision ? `\n## 修复版记录\n\n本报告采用 ${agenticVariant} 的完整独立重跑，不复用旧版成功回答。版本标识：\n\n\`\`\`json\n${JSON.stringify(plan.agenticRevision, null, 2)}\n\`\`\`\n\n旧版 43/50 的完成率与七次来源契约错误见上级目录 current-version-diagnosis.md，不因修复版结果而删除。检索费用累计包含旧版、试跑和修复版，不是本表 50 题单独费用。\n` : "";
writeFileSync(join(dest, "comparison.md"), md + revisionNote + "\n质量与时延取每题最后一次成功回答；首次完成数保留原始失败，attempts 含人工确认后补跑。表中 modelCalls、inputTokens、outputTokens 和 unknownUsage 仅统计这 50 题所有生成尝试的 Sol 请求，不含 Astra 评分请求；评分用量另记于订阅用量日志。unknownUsage 非零时 token 只是已知部分，不能视作完整成本。知识库调用均值对应被评分的最后一次成功回答。\n");
console.log(JSON.stringify({ traditional: traditional.summary, agentic: agentic.summary, comparison, retrievalBudget: report.retrievalBudget }, null, 2));
