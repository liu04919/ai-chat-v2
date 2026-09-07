"""用 ranx 计算指标；只做输入校验和报告，不自行重写 IR 指标公式。"""
import argparse
import json
from importlib.metadata import version
from pathlib import Path

import numpy as np
from ranx import Qrels, Run, evaluate

ARMS = ["vector", "bm25", "hybrid", "hybrid_rerank"]
METRICS = ["precision@5", "precision@10", "recall@5", "recall@10", "recall@50", "ndcg@10", "mrr@10"]


def evaluate_runs(qrels_dict, rows, arms=None):
    ids = [r["id"] for r in rows]
    if len(ids) != len(set(ids)) or set(ids) != set(qrels_dict):
        raise ValueError("结果必须覆盖全部选定问题且 ID 不重复；不允许静默丢弃失败样本")
    qrels = Qrels(qrels_dict)
    scores, per_query = {}, {}
    for arm in ARMS if arms is None else arms:
        run_dict = {}
        for row in rows:
            hits = row["runs"][arm]
            if len({h["id"] for h in hits}) != len(hits):
                raise ValueError("重复 passage ID")
            # ranx 大分在前；用严格递减的名次分保持 SQL/RRF/精排的既定顺序。
            # 原始余弦距离/BM25/RRF/精排分数仍完整保存在 results.jsonl。
            run_dict[row["id"]] = {hit["id"]: 1.0 / (rank + 1) for rank, hit in enumerate(hits)}
        run = Run(run_dict, name=arm)
        scores[arm] = evaluate(qrels, run, METRICS, threads=1)
        per_query[arm] = {metric: dict(values) for metric, values in run.scores.items()}
    return scores, per_query


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", nargs="?", default=str(Path(__file__).parent / "artifacts/duretrieval"))
    parser.add_argument("--publish", action="store_true", help="把无原文的报告与逐题指标归档到可提交的 reports 目录")
    args = parser.parse_args()
    root = Path(args.directory)
    qrels = json.loads((root / "qrels.json").read_text(encoding="utf8"))
    rows = [json.loads(line) for line in (root / "results.jsonl").read_text(encoding="utf8").splitlines() if line]
    scores, per_query = evaluate_runs(qrels, rows)
    failure_path = root / "failures.jsonl"
    failures = [json.loads(line) for line in failure_path.read_text(encoding="utf8").splitlines() if line] if failure_path.exists() else []
    # ingest 外层还会记录受影响 ID，不把内外两条日志重复计为两次模型请求失败。
    failed_attempts = [row for row in failures if row.get("kind") != "ingest"]
    latency = {}
    for arm in ARMS:
        values = []
        for row in rows:
            t = row["timing"]
            values.append({"vector": t["embeddingMs"] + t["semanticMs"], "bm25": t["lexicalMs"],
                           "hybrid": t["embeddingMs"] + t["parallelMs"] + t["fusionMs"],
                           "hybrid_rerank": t["embeddingMs"] + t["parallelMs"] + t["fusionMs"] + t["rerankMs"]}[arm])
        latency[arm] = {"p50Ms": float(np.percentile(values, 50)), "p95Ms": float(np.percentile(values, 95))}
    # 固定种子的逐题配对 bootstrap；只给差值区间，不把 100 题宣传为官方全量排名。
    rng = np.random.default_rng(20260906)
    intervals = {}
    ids = sorted(qrels)
    for before, after in [("vector", "hybrid"), ("hybrid", "hybrid_rerank")]:
        differences = np.array([per_query[after]["ndcg@10"][qid] - per_query[before]["ndcg@10"][qid] for qid in ids])
        samples = rng.choice(differences, size=(10000, len(ids)), replace=True).mean(axis=1)
        intervals[f"{after}-{before}"] = {"meanDelta": float(differences.mean()), "pairedBootstrap95CI": np.percentile(samples, [2.5, 97.5]).tolist()}
    report = {"status": "complete", "queries": len(rows), "engine": f"ranx {version('ranx')}", "metrics": scores,
              "failedAttempts": failed_attempts,
              "latency": latency, "ndcg10Comparisons": intervals, "cost": json.loads((root / "cost.json").read_text()),
              "manifest": json.loads((root / "manifest.json").read_text(encoding="utf8")),
              "run": json.loads((root / "run.json").read_text(encoding="utf8"))}
    (root / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf8")
    (root / "per-query-metrics.json").write_text(json.dumps(per_query, indent=2), encoding="utf8")
    lines = ["# DuRetrieval 检索层消融实验", "", f"完整 {report['manifest']['corpusCount']:,} 条 passage；固定抽取上游 dev 的 {len(rows)} 题。不是官方全量测试成绩。", "",
             "| 方案 | Recall@5 | Recall@10 | Recall@50 | nDCG@10 | MRR@10 | P50 ms | P95 ms |", "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for arm in ARMS:
        m, t = scores[arm], latency[arm]
        lines.append(f"| {arm} | {m['recall@5']:.4f} | {m['recall@10']:.4f} | {m['recall@50']:.4f} | {m['ndcg@10']:.4f} | {m['mrr@10']:.4f} | {t['p50Ms']:.1f} | {t['p95Ms']:.1f} |")
    lines += ["", "指标由 ranx 计算，完整 Precision 指标及逐题分数见 JSON。时间是共享负载下各阶段观测值的组合，不是四套服务的独立压测；包含查询 Embedding，不包含离线建库。", "",
              f"执行期间记录 {len(failed_attempts)} 次失败尝试，恢复后才生成完整成绩。延迟仅统计成功尝试，不包括失败尝试或人工等待；失败详情见 report.json。", "",
              f"预算记账：¥{report['cost']['accountedCny']:.4f} / ¥{report['cost']['limitCny']:.2f}（实际 token 按公开原价估算，失败/未知用量保留预算预留；不是云账单）。", "",
              "保留原始 passage，不测文件解析/切块、最终回答、引用正确性或 Agentic RAG。未标注结果按不相关处理，不等于它实际无关；100 题结果有抽样不确定性。", "",
              "## nDCG@10 配对差值", ""]
    for comparison, value in intervals.items():
        low, high = value["pairedBootstrap95CI"]
        lines.append(f"- {comparison}: {value['meanDelta']:+.4f}，95% bootstrap 区间 [{low:+.4f}, {high:+.4f}]。")
    markdown = "\n".join(lines) + "\n"
    (root / "report.md").write_text(markdown, encoding="utf8")
    if args.publish:
        run_id = report["run"]["startedAt"].replace(":", "-").replace(".", "-")
        target = Path(__file__).parent / "reports" / f"duretrieval-{run_id}"
        target.mkdir(parents=True, exist_ok=True)
        (target / "report.md").write_text(markdown, encoding="utf8")
        (target / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf8")
        (target / "per-query-metrics.json").write_text(json.dumps(per_query, indent=2), encoding="utf8")
    print(json.dumps({"metrics": scores, "latency": latency, "cost": report["cost"]}, indent=2))


if __name__ == "__main__":
    main()
