import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { KnowledgeSourceDto, KnowledgeChunk } from "@ai-chat/contracts";
import { type EvalQuestion } from "./dataset";

const root = fileURLToPath(new URL("../artifacts/cmrc2018/", import.meta.url));
const read = <T>(name: string): T => JSON.parse(readFileSync(join(root, name), "utf8")) as T;
const rows = <T>(name: string): T[] => readFileSync(join(root, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
type Answer = { id: string; answer: string; ok: boolean; sources: KnowledgeSourceDto[]; timing: { firstTextMs: number | null; totalMs: number } | null };
type Score = { id: string; answerSha256?: string; judge: string; executor?: string; faithfulness: number; answer_accuracy: number };

export function interval(values: number[]) {
  let seed = 20260908;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const boot = Array.from({ length: 2000 }, () => mean(Array.from({ length: values.length }, () => values[Math.floor(next() * values.length)]))).sort((a, b) => a - b);
  return { mean: mean(values), ci95: [boot[50], boot[1949]] };
}
export function citationFormat(answer: string, sources: KnowledgeSourceDto[]) {
  const links = [...answer.matchAll(/\[(\d+)\]\(#knowledge-(\d+)\)/g)];
  return { count: links.length, valid: links.filter((m) => m[1] === m[2] && sources.some((s) => s.number === Number(m[1]))).length };
}

async function main() {
  const questions = read<EvalQuestion[]>("test.json");
  const attempts = rows<Answer>("test-answers.jsonl");
  const answers = [...new Map(attempts.map((r) => [r.id, r])).values()];
  const offline = process.argv.includes("--offline-judge");
  const scores = offline ? read<Score[]>("offline/test/scores.json") : rows<Score>("test-scores.jsonl");
  const expected = new Set(questions.map((q) => q.id));
  for (const list of [answers, scores]) if (list.length !== questions.length || new Set(list.map((r) => r.id)).size !== expected.size || list.some((r) => !expected.has(r.id))) throw new Error("INCOMPLETE_TEST_SET");
  if (answers.some((a) => !a.ok) || scores.some((s) => !Number.isFinite(s.faithfulness) || !Number.isFinite(s.answer_accuracy))) throw new Error("FAILED_TEST_ROWS");
  const corpus = read<{ text: string }[]>("corpus.json");
  const documentLengths = corpus.map((d) => d.text.length).sort((a, b) => a - b);
  const lengthProfile = { count: corpus.length, atMost800: documentLengths.filter((n) => n <= 800).length, median: documentLengths[Math.floor(documentLengths.length / 2)], max: documentLengths.at(-1), unit: "UTF-16 characters" };
  const chunks = read<(KnowledgeChunk & { id: string; documentId: string })[]>("chunks.json");
  const perQuestion = questions.map((q) => {
    const answer = answers.find((a) => a.id === q.id)!;
    const score = scores.find((s) => s.id === q.id)!;
    if (score.answerSha256 && score.answerSha256 !== createHash("sha256").update(answer.answer).digest("hex")) throw new Error("SCORED_ANSWER_CHANGED");
    const evidence = answer.sources.map((s) => s.originalName === `${q.documentId}.txt` && chunks.some((c) => c.documentId === q.documentId && c.content === s.content && q.answers.some((a) => c.start <= a.start && c.end >= a.end)));
    const rank = evidence.indexOf(true);
    return { id: q.id, answerAccuracy: score.answer_accuracy, faithfulness: score.faithfulness, evidenceHitAt6: Number(rank >= 0), evidenceMrrAt6: rank < 0 ? 0 : 1 / (rank + 1), citationFormat: citationFormat(answer.answer, answer.sources), timing: answer.timing };
  });
  const runtime = read<{ meterUrl: string; meterToken: string }>("runtime.json");
  if (!runtime.meterUrl.startsWith("http://127.0.0.1:")) throw new Error("INVALID_METER");
  const costResponse = await fetch(runtime.meterUrl + "/budget", { headers: { authorization: `Bearer ${runtime.meterToken}` } });
  if (!costResponse.ok) throw new Error("BUDGET_READ_FAILED");
  const cost = await costResponse.json();
  const percentiles = (values: number[]) => { const sorted = values.sort((a, b) => a - b); return { count: sorted.length, p50: sorted[Math.floor((sorted.length - 1) * 0.5)], p95: sorted[Math.floor((sorted.length - 1) * 0.95)] }; };
  const summary = {
    count: questions.length, corpusLengthProfile: lengthProfile, judge: [...new Set(scores.map((s) => s.judge))], judgeExecutor: offline ? "Codex fresh-context subagents, batched native prompts" : "metered API",
    attempts: attempts.length, failedAttempts: attempts.filter((a) => !a.ok).length,
    firstAttemptSuccess: questions.filter((q) => attempts.find((a) => a.id === q.id)?.ok).length / questions.length,
    answerAccuracy: interval(perQuestion.map((r) => r.answerAccuracy)), faithfulness: interval(perQuestion.map((r) => r.faithfulness)),
    answerAccuracyDistribution: Object.fromEntries([0, 0.25, 0.5, 0.75, 1].map((score) => [score, perQuestion.filter((r) => r.answerAccuracy === score).length])),
    evidenceHitAt6: interval(perQuestion.map((r) => r.evidenceHitAt6)), evidenceMrrAt6: interval(perQuestion.map((r) => r.evidenceMrrAt6)),
    citationFormat: { total: perQuestion.reduce((n, r) => n + r.citationFormat.count, 0), valid: perQuestion.reduce((n, r) => n + r.citationFormat.valid, 0), answersWithCitation: perQuestion.filter((r) => r.citationFormat.count > 0).length },
    firstTextMs: percentiles(perQuestion.flatMap((r) => r.timing?.firstTextMs == null ? [] : [r.timing.firstTextMs])),
    totalMs: percentiles(perQuestion.flatMap((r) => r.timing ? [r.timing.totalMs] : [])), cost,
  };
  let tuningText = "参数实验尚未完成。";
  if (existsSync(join(root, "test-retrieval.jsonl"))) {
    const selected = read<{ size: number; overlap: number; candidates: number; retained: number }>("selected-config.json");
    const retrieval = rows<{ id: string; size: number; overlap: number; candidates: number; retained: number; hit: number; mrr: number }>("test-retrieval.jsonl");
    const baseline = retrieval.filter((r) => r.size === 800 && r.overlap === 100 && r.candidates === 30 && r.retained === 6);
    const winner = retrieval.filter((r) => r.size === selected.size && r.overlap === selected.overlap && r.candidates === selected.candidates && r.retained === selected.retained);
    if ([baseline, winner].some((list) => list.length !== questions.length || new Set(list.map((r) => r.id)).size !== questions.length)) throw new Error("INCOMPLETE_HELD_OUT_COMPARISON");
    const unchanged = selected.size === 800 && selected.overlap === 100 && selected.candidates === 30 && selected.retained === 6;
    if (unchanged) {
      const top3 = retrieval.filter((r) => r.size === 800 && r.overlap === 100 && r.candidates === 30 && r.retained === 3);
      if (top3.length !== questions.length || new Set(top3.map((r) => r.id)).size !== questions.length) throw new Error("INCOMPLETE_TOP3_COMPARISON");
      tuningText = `24 组配置在 20 道调参题上比较；全部 24 组的已知答案 hit 均为 1.000、MRR 均为 0.975；默认 800/100、每路 30、保留 6 没有胜出，按预先约定保留默认值。不是选出了一个比默认更好的新配置。\n\n独立 50 题中，默认 evidence hit@6=${mean(baseline.map((r) => r.hit)).toFixed(3)}，MRR@6=${mean(baseline.map((r) => r.mrr)).toFixed(3)}；同一精排列表取前 3 条时 hit@3=${mean(top3.map((r) => r.hit)).toFixed(3)}，MRR@3=${mean(top3.map((r) => r.mrr)).toFixed(3)}。短文数据上 3 条已经包含已知答案，但未对 3 条上下文重新生成回答，不能据此证明其最终回答质量等价。也不对同一配置与自身计算所谓提升置信区间。`;
    } else {
      const difference = interval(questions.map((q) => winner.find((r) => r.id === q.id)!.hit - baseline.find((r) => r.id === q.id)!.hit));
      tuningText = `调参选择：${selected.size}/${selected.overlap}，每路 ${selected.candidates}，保留 ${selected.retained}。\n\n独立 50 题验证：默认 evidence hit=${mean(baseline.map((r) => r.hit)).toFixed(3)}，候选=${mean(winner.map((r) => r.hit)).toFixed(3)}；配对差异 95% bootstrap CI=${JSON.stringify(difference.ci95)}。这只是已知证据召回比较，不代表候选配置的最终回答质量更高。`;
    }
  }
  const judgeText = offline
    ? "评分执行器为明确指定 gpt-6-astra 的 Codex 子 agent，不继承主对话；事实拆分、准确性、证据判断分开导出，评委不读取生成模型名称、参数方案和其他分数。每批内共享上下文，因此不是每次 API 调用完全独立的原执行方式。子 agent 只生成结构化判断，Ragas 原算法回放计算；保留模型请求设置、任务映射、原始提示与输出。这是模型盲评，不是人工标注或官方认证成绩。Codex 额度独立于中转 API 费用，未折算人民币。"
    : `评分使用渠道 ${summary.judge.join(", ")} / low；模型名称不证明渠道上游身份。${summary.judge.includes("gpt-5.6-sol") ? "回答与评分同型号，存在自评偏差风险。" : ""}`;
  const grid = read<{ size: number; overlap: number; candidates: number; retained: number; knownAnswerHit: number; mrr: number; contextBytes: number }[]>("tuning-summary.json");
  const gridTable = ["| 分块 | 每路召回 | 保留 | 已知答案 hit | MRR | 平均上下文字节 |", "| --- | ---: | ---: | ---: | ---: | ---: |", ...grid.map((g) => `| ${g.size}/${g.overlap} | ${g.candidates} | ${g.retained} | ${g.knownAnswerHit.toFixed(3)} | ${g.mrr.toFixed(3)} | ${g.contextBytes.toFixed(0)} |`)].join("\n");
  const fmt = (metric: ReturnType<typeof interval>) => `${metric.mean.toFixed(4)}（95% bootstrap CI ${metric.ci95.map((n) => n.toFixed(4)).join("–")}）`;
  const text = `# 传统 RAG 小规模端到端评测\n\n来源：CMRC 2018 dev 改造；不是官方榜单成绩。全部 848 段原文导入，业务 800/100 切成 948 块；5 题试跑、20 题调参、50 题测试按源文章隔离。176 道存在至少一个无效答案位置的题被保守排除，保留排除清单。\n\n## 默认业务链路结果\n\n首次成功 ${Math.round(summary.firstAttemptSuccess * questions.length)}/${questions.length}；共 ${summary.attempts} 次尝试、${summary.failedAttempts} 次失败。以下质量分数针对重试后最终成功回答，不代表一次请求即可达到该效果。\n\n- Ragas AnswerAccuracy：${fmt(summary.answerAccuracy)}\n- Ragas Faithfulness：${fmt(summary.faithfulness)}\n- 已标注答案区间 evidence hit@6：${fmt(summary.evidenceHitAt6)}\n- evidence MRR@6：${fmt(summary.evidenceMrrAt6)}\n- 引用链接编号有效：${summary.citationFormat.valid}/${summary.citationFormat.total}（只校验格式和编号，不等于引用语义正确）\n- 首正文 p50/p95：${summary.firstTextMs.p50?.toFixed(0)}/${summary.firstTextMs.p95?.toFixed(0)} ms\n- 总耗时 p50/p95：${summary.totalMs.p50?.toFixed(0)}/${summary.totalMs.p95?.toFixed(0)} ms\n\n## 参数对比\n\n${tuningText}\n\n原文长度中位数 ${lengthProfile.median} 字符、最大 ${lengthProfile.max} 字符；${lengthProfile.atMost800}/${lengthProfile.count} 篇不超过 800 字符，因此多数原文本来就无需按 800 切开。这轮不能回答长文件的最佳分块/重叠是多少。\n\n### 调参集全部 24 组结果（20 题）\n\n${gridTable}\n\n## 分数解读\n\nAnswerAccuracy 不是答对题目比例；本轮分布为 ${Object.entries(summary.answerAccuracyDistribution).map(([score, count]) => `${score} 分：${count} 题`).join("、")}。固定第一份参考存在标注冲突和短答案等价性限制，不能将 ${summary.answerAccuracy.mean.toFixed(3)} 直接宣传成准确率。参见 [扣分抽查](score-audit.md)。样本全 1 时 bootstrap 区间退化不代表总体 100% 保证。\n\n## 口径和限制\n\n真实 HTTP 注册、知识库创建、预签名 R2 上传、Worker 解析入库、Generation/SSE 与落库回答一致性检查。业务 PostgreSQL 和队列未参与；不是浏览器 UI 自动化。参数网格走同一业务 parser、SQL、RRF、reranker，但离线批量入库，不重复上传 R2。每个分块库独立，避免混合 BM25 统计。\n\n回答使用渠道 gpt-5.6-sol / medium，渠道名称不证明模型来源。${judgeText}评测额外限制输出 8192 token，未修改业务提示词。Ragas 0.4.3 原始英文评分提示处理中文；AnswerAccuracy 的两次判断是同一个评分模型，不是两个独立评委。采用第一份人工短答案；长回答的额外事实由 Faithfulness 辅助检查。保留评分原始结构化输出，未经完整人工校准。\n\nCMRC 原文较短且为可回答的百科问题：未覆盖长 PDF、OCR、表格、拒答、多轮对话或恶意文档，不能证明全场景可靠。Known-answer hit 只检查上游已知答案区间，不是穷尽相关性 Recall。延迟来自本地开发实例和共享渠道，调参期间有并行入库负载，不是独立性能压测。参数网格是有限对照，不保证全局最优；业务默认参数未自动修改。\n\n费用见 report.json；账本跨重启累计，未知用量保留预留，缓存按最高输入档保守计费，估算不是供应商最终账单。\n`;
  writeFileSync(join(root, "report.md"), text);
  writeFileSync(join(root, "report.json"), JSON.stringify({ summary, perQuestion }, null, 2) + "\n");
  if (process.argv.includes("--publish")) {
    const destination = fileURLToPath(new URL("../reports/cmrc2018-v1/", import.meta.url));
    mkdirSync(destination, { recursive: true });
    if (offline) {
      copyFileSync(join(root, "offline/test/judgment-manifest.json"), join(destination, "judgment-manifest.json"));
      if (existsSync(join(root, "offline/executor.json"))) copyFileSync(join(root, "offline/executor.json"), join(destination, "executor.json"));
    }
    for (const name of ["report.md", "report.json", "manifest.json", "tuning-plan.json", "tuning-summary.json", "selected-config.json"]) if (existsSync(join(root, name))) copyFileSync(join(root, name), join(destination, name));
  }
  console.log(JSON.stringify(summary, null, 2));
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/report.ts")) main().catch(() => { console.error("REPORT_FAILED"); process.exitCode = 1; });
