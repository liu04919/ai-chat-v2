"""固定候选的精排补测：复用 ranx 指标，报告 BM25 的边际价值而非预设结论。"""
import argparse
import hashlib
import json
from importlib.metadata import version
from pathlib import Path

import numpy as np
from score import evaluate_runs

ARMS = ["vector", "bm25", "hybrid", "vector_rerank", "hybrid_rerank"]
PAIRS = [("vector", "vector_rerank"), ("hybrid", "hybrid_rerank"),
         ("vector_rerank", "hybrid_rerank")]


def read_json(path):
    return json.loads(path.read_text(encoding="utf8"))


def read_rows(path):
    return [json.loads(line) for line in path.read_text(encoding="utf8").splitlines() if line]


def combine_rows(baseline, reranked, qrels):
    original = {r["id"]: r for r in baseline}
    if len(original) != len(baseline) or set(original) != set(qrels):
        raise ValueError("旧结果必须恰好覆盖全部选定问题")
    expected = {(qid, arm) for qid in qrels for arm in ["vector", "hybrid"]}
    actual = {(r["id"], r["arm"]) for r in reranked}
    if actual != expected or len(actual) != len(reranked):
        raise ValueError("补测必须每题两组全部完成，且不重复")
    lookup = {(r["id"], r["arm"]): r for r in reranked}
    combined, candidate_rows = [], []
    for qid, row in original.items():
        for arm in ["vector", "hybrid"]:
            candidates = [h["id"] for h in row["runs"][arm]]
            new = [h["id"] for h in lookup[(qid, arm)]["hits"]]
            if len(candidates) != 50 or len(set(candidates)) != 50 or len(new) != 50 or len(set(new)) != 50 or set(new) != set(candidates):
                raise ValueError("精排必须保留原来的 50 个候选，不得补文档、丢文档或重复")
        runs = {arm: row["runs"][arm] for arm in ["vector", "bm25", "hybrid"]}
        runs.update({f"{arm}_rerank": lookup[(qid, arm)]["hits"] for arm in ["vector", "hybrid"]})
        combined.append({"id": qid, "runs": runs})
        v = {h["id"] for h in runs["vector"]}
        h = {h["id"] for h in runs["hybrid"]}
        b = {h["id"] for h in runs["bm25"]}
        if not (h - v).issubset(b):
            raise ValueError("混合独有候选必须来自 BM25")
        relevant = {pid for pid, grade in qrels[qid].items() if grade > 0}
        candidate_rows.append({"id": qid, "query": row["query"], "qrelsRelevant": len(relevant),
            "vectorRelevant": sorted(v & relevant), "hybridRelevant": sorted(h & relevant),
            "addedByHybrid": sorted(h - v), "droppedByHybrid": sorted(v - h),
            "addedRelevant": sorted((h - v) & relevant), "droppedRelevant": sorted((v - h) & relevant)})
    return combined, candidate_rows, lookup


def paired_comparison(before, after, ids):
    differences = np.array([float(after[qid]) - float(before[qid]) for qid in ids])
    rng = np.random.default_rng(20260907)
    samples = rng.choice(differences, size=(10000, len(ids)), replace=True).mean(axis=1)
    return {"meanDelta": float(differences.mean()),
            "pairedBootstrap95CI": np.percentile(samples, [2.5, 97.5]).tolist(),
            "wins": int((differences > 1e-12).sum()), "ties": int((abs(differences) <= 1e-12).sum()),
            "losses": int((differences < -1e-12).sum())}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", type=Path, default=Path(__file__).parent / "artifacts/duretrieval")
    parser.add_argument("--directory", type=Path, default=Path(__file__).parent / "artifacts/duretrieval-rerank-ablation")
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    run = read_json(args.directory / "run.json")
    for name, digest in run["parameters"]["baselineFiles"].items():
        if hashlib.sha256((args.baseline / name).read_bytes()).hexdigest() != digest:
            raise ValueError("基线文件指纹不一致")
    qrels = read_json(args.baseline / "qrels.json")
    baseline = read_rows(args.baseline / "results.jsonl")
    reranked = read_rows(args.directory / "results.jsonl")
    rows, candidate_rows, lookup = combine_rows(baseline, reranked, qrels)
    scores, per_query = evaluate_runs(qrels, rows, ARMS)
    legacy_scores, legacy_per_query = evaluate_runs(qrels, baseline)
    original_report = read_json(args.baseline / "report.json")
    for arm, metrics in legacy_scores.items():
        for metric, value in metrics.items():
            if abs(value - original_report["metrics"][arm][metric]) > 1e-12:
                raise ValueError("旧排名重算成绩与旧报告不一致")
    ids = sorted(qrels)
    comparisons = {}
    for before, after in PAIRS:
        comparisons[f"{after}-{before}"] = {
            metric: paired_comparison(per_query[before][metric], per_query[after][metric], ids)
            for metric in ["ndcg@10", "recall@10", "mrr@10"]}
    for entry in candidate_rows:
        qid = entry["id"]
        entry["ndcg10Delta"] = per_query["hybrid_rerank"]["ndcg@10"][qid] - per_query["vector_rerank"]["ndcg@10"][qid]
        entry["vectorRerankNdcg10"] = per_query["vector_rerank"]["ndcg@10"][qid]
        entry["hybridRerankNdcg10"] = per_query["hybrid_rerank"]["ndcg@10"][qid]
        entry["vectorRerankTop10"] = [h["id"] for h in lookup[(qid, "vector")]["hits"][:10]]
        entry["hybridRerankTop10"] = [h["id"] for h in lookup[(qid, "hybrid")]["hits"][:10]]
    candidate_summary = {
        "queriesWithRelevantAdded": sum(bool(r["addedRelevant"]) for r in candidate_rows),
        "queriesWithRelevantDropped": sum(bool(r["droppedRelevant"]) for r in candidate_rows),
        "queriesWithBoth": sum(bool(r["addedRelevant"]) and bool(r["droppedRelevant"]) for r in candidate_rows),
        "addedRelevantPairs": sum(len(r["addedRelevant"]) for r in candidate_rows),
        "droppedRelevantPairs": sum(len(r["droppedRelevant"]) for r in candidate_rows),
        "meanAddedCandidates": float(np.mean([len(r["addedByHybrid"]) for r in candidate_rows])),
    }
    stability = paired_comparison(legacy_per_query["hybrid_rerank"]["ndcg@10"], per_query["hybrid_rerank"]["ndcg@10"], ids)
    stability["identicalTop10Queries"] = sum(
        [h["id"] for h in r["runs"]["hybrid_rerank"][:10]] == [h["id"] for h in lookup[(r["id"], "hybrid")]["hits"][:10]]
        for r in baseline)
    timing = {}
    for arm in ["vector", "hybrid"]:
        results = [r for r in reranked if r["arm"] == arm]
        timing[f"{arm}_rerank"] = {
            "p50Ms": float(np.percentile([r["rerankMs"] for r in results], 50)),
            "p95Ms": float(np.percentile([r["rerankMs"] for r in results], 95)),
            "knownTokens": sum(r["tokens"] or 0 for r in results),
            "missingUsage": sum(r["tokens"] is None for r in results),
        }
    failures = read_rows(args.directory / "failures.jsonl") if (args.directory / "failures.jsonl").exists() else []
    report = {"status": "complete", "queries": len(ids), "corpusCount": run["corpusCount"],
        "engine": f"ranx {version('ranx')}", "metrics": scores, "comparisons": comparisons,
        "candidateSummary": candidate_summary, "legacyHybridRerankStability": stability,
        "rerankOnlyTiming": timing, "failedAttempts": failures,
        "cost": read_json(args.directory / "cost.json"), "run": run,
        "scorerHashes": {name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest() for name in ["score.py", "rerank_score.py"]},
    }
    main_comparison = comparisons["hybrid_rerank-vector_rerank"]["ndcg@10"]
    low, high = main_comparison["pairedBootstrap95CI"]
    conclusion = ("本样本中，混合＋精排领先。" if low > 0 else
                  "本样本中，纯向量＋精排领先。" if high < 0 else
                  "差值区间跨过 0，本样本不足以判定两组存在稳定优势。")
    lines = ["# DuRetrieval：纯向量＋精排 vs 混合＋精排", "", conclusion, "",
        f"完整 {run['corpusCount']:,} 条原始 passage、同一批 {len(ids)} 道 dev 题。复用旧 Vector Top 50 与 RRF Top 50 候选；两组本轮重新调用同一个 `{run['parameters']['rerankModel']}`，各精排 50 条，逐题交替先后顺序。没有新 Embedding、数据库检索或业务库写入。", "",
        "| 方案 | Recall@5 | Recall@10 | Recall@50 | nDCG@10 | MRR@10 |", "|---|---:|---:|---:|---:|---:|"]
    for arm in ARMS:
        m = scores[arm]
        lines.append(f"| {arm} | {m['recall@5']:.4f} | {m['recall@10']:.4f} | {m['recall@50']:.4f} | {m['ndcg@10']:.4f} | {m['mrr@10']:.4f} |")
    lines += ["", "前三组为旧候选原排名；后两组为本轮新精排。指标由 ranx 计算，旧排名重算已与旧报告逐项核对。", "", "## 配对比较", "",
        "主指标为 nDCG@10，差值方向为后者减前者。逐题配对 bootstrap 10,000 次，固定种子 20260907；胜/平/负按逐题分数比较。其他指标见 JSON，属于探索性分析，未做多重比较校正。", ""]
    for pair, values in comparisons.items():
        v = values["ndcg@10"]
        lo, hi = v["pairedBootstrap95CI"]
        lines.append(f"- `{pair}`：{v['meanDelta']:+.4f}，95% CI [{lo:+.4f}, {hi:+.4f}]；胜/平/负 {v['wins']}/{v['ties']}/{v['losses']}。")
    lines += ["", "## BM25 候选的收益与代价", "",
        f"混合 Top 50 平均替换 {candidate_summary['meanAddedCandidates']:.2f} 个向量候选。依据 qrels，{candidate_summary['queriesWithRelevantAdded']} 题新增标注相关 passage（共 {candidate_summary['addedRelevantPairs']} 个 query-passage 对），{candidate_summary['queriesWithRelevantDropped']} 题丢失标注相关 passage（共 {candidate_summary['droppedRelevantPairs']} 对）；其中 {candidate_summary['queriesWithBoth']} 题两者同时发生。", "",
        "这是固定 50 个精排候选的比较，不是向量 Top 50 与两路候选完整并集（最多 100 条）的比较。RRF 截断可能挤掉相关候选；精排只能重排已有候选，不能补回漏召回内容。未标注 passage 按不相关计分，并不证明其实际无关。", "", "### 最大差异示例", "",
        "下表仅展示问题和 passage ID，不发布语料正文。正差值代表混合＋精排更高；不能把排名变化直接解释成因果或回答正确率。", "",
        "| 问题 ID / 问题 | nDCG@10 差值 | 混合新增相关 ID | 混合丢失相关 ID |", "|---|---:|---|---|"]
    examples = sorted([r for r in candidate_rows if r["ndcg10Delta"] > 1e-12], key=lambda r: -r["ndcg10Delta"])[:3]
    examples += sorted([r for r in candidate_rows if r["ndcg10Delta"] < -1e-12], key=lambda r: r["ndcg10Delta"])[:3]
    for r in examples:
        question = r["query"].replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {r['id']} / {question} | {r['ndcg10Delta']:+.4f} | {', '.join(r['addedRelevant']) or '—'} | {', '.join(r['droppedRelevant']) or '—'} |")
    lines += ["", "## 重跑稳定性、耗时和费用", "",
        f"相同混合候选的新旧精排：nDCG@10 均值差 {stability['meanDelta']:+.6f}，Top 10 排名完全相同 {stability['identicalTop10Queries']}/{len(ids)} 题。公开模型名不等于固定权重版本，仍不能保证以后完全复现。", "",
        "| 精排阶段（不含 Embedding/SQL） | P50 ms | P95 ms | 已知输入 tokens |", "|---|---:|---:|---:|"]
    for arm, t in timing.items():
        lines.append(f"| {arm} | {t['p50Ms']:.1f} | {t['p95Ms']:.1f} | {t['knownTokens']:,} |")
    cost = report["cost"]
    lines += ["", f"本轮失败尝试 {len(failures)} 次；耗时仅记录成功请求，不含失败等待。这不是并发压测或完整 RAG 延迟。", "",
        f"本轮新增预算记账 ¥{cost['incrementalAccountedCny']:.4f}；含上次实验累计 ¥{cost['accountedCny']:.4f} / ¥{cost['limitCny']:.2f}。按 API usage 和北京公开原价估算，失败/未知用量保留预留，不是云账单。[模型定价](https://help.aliyun.com/zh/model-studio/qwen3-7-text-rerank)。", "",
        "## 结论边界", "", conclusion,
        "结果只适用于这批 100 题、当前模型和固定候选预算；不是官方全量成绩，不证明 BM25 普遍无用或必需，也不证明 Agentic RAG 更好。未评估上传文件的 800/100 分块、业务 30/6 参数、最终回答与引用质量。不要据此直接切换业务方案。", ""]
    markdown = "\n".join(lines)
    outputs = {"report.json": json.dumps(report, ensure_ascii=False, indent=2), "report.md": markdown,
        "per-query-metrics.json": json.dumps(per_query, indent=2),
        "candidate-analysis.json": json.dumps(candidate_rows, ensure_ascii=False, indent=2)}
    targets = [args.directory]
    if args.publish:
        run_id = run["startedAt"].replace(":", "-").replace(".", "-")
        targets.append(Path(__file__).parent / "reports" / f"rerank-ablation-{run_id}")
    for target in targets:
        target.mkdir(parents=True, exist_ok=True)
        for name, text in outputs.items():
            (target / name).write_text(text + "\n", encoding="utf8")
    print(json.dumps({"metrics": scores, "primaryComparison": main_comparison, "candidates": candidate_summary, "cost": cost}, indent=2))


if __name__ == "__main__":
    main()
