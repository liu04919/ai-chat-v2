import unittest
import contextlib
import io
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
from score import ARMS, evaluate_runs, main


class ScoreTest(unittest.TestCase):
    def test_known_ranks_and_empty_results(self):
        rows = [{"id": "q1", "runs": {a: [{"id": "x"}, {"id": "b"}] for a in ARMS}},
                {"id": "q2", "runs": {a: [] for a in ARMS}}]
        scores, _ = evaluate_runs({"q1": {"b": 1, "c": 1}, "q2": {"d": 1}}, rows)
        for metrics in scores.values():
            self.assertAlmostEqual(metrics["recall@5"], .25)
            self.assertAlmostEqual(metrics["precision@5"], .1)
            self.assertAlmostEqual(metrics["mrr@10"], .25)

    def test_missing_or_duplicate_queries_rejected(self):
        row = {"id": "q1", "runs": {a: [] for a in ARMS}}
        for rows in [[], [row, row]]:
            with self.assertRaises(ValueError):
                evaluate_runs({"q1": {"a": 1}}, rows)

    def test_report_cli_writes_serializable_artifacts(self):
        with tempfile.TemporaryDirectory(prefix="rag-score-test-") as directory:
            root = Path(directory)
            files = {"qrels.json": {"q1": {"a": 1}}, "manifest.json": {"corpusCount": 2},
                     "run.json": {"startedAt": "2026-09-06T00:00:00.000Z"},
                     "cost.json": {"accountedCny": .01, "limitCny": 20}}
            for name, value in files.items():
                (root / name).write_text(json.dumps(value), encoding="utf8")
            row = {"id": "q1", "runs": {arm: [{"id": "a"}] for arm in ARMS},
                   "timing": {"embeddingMs": 5, "semanticMs": 2, "lexicalMs": 3, "parallelMs": 3, "fusionMs": 1, "rerankMs": 10}}
            (root / "results.jsonl").write_text(json.dumps(row) + "\n", encoding="utf8")
            with patch("sys.argv", ["score.py", directory]), contextlib.redirect_stdout(io.StringIO()):
                main()
            report = json.loads((root / "report.json").read_text(encoding="utf8"))
            self.assertEqual(report["status"], "complete")
            self.assertEqual(report["metrics"]["vector"]["recall@10"], 1)
            self.assertEqual(report["latency"]["bm25"]["p50Ms"], 3)
            self.assertEqual(report["latency"]["hybrid_rerank"]["p50Ms"], 19)
            self.assertTrue((root / "per-query-metrics.json").exists())
            self.assertTrue((root / "report.md").exists())


if __name__ == "__main__":
    unittest.main()
