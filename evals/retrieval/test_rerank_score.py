import unittest
from rerank_score import combine_rows, paired_comparison
from score import evaluate_runs


def fixture():
    hits = [{"id": str(i)} for i in range(50)]
    baseline = [{"id": "q1", "query": "问题", "runs": {arm: hits for arm in ["vector", "hybrid", "bm25"]}}]
    reranked = [{"id": "q1", "arm": arm, "hits": list(reversed(hits))} for arm in ["vector", "hybrid"]]
    return baseline, reranked, {"q1": {"49": 1}}


class RerankScoreTest(unittest.TestCase):
    def test_ranx_uses_reranked_order(self):
        baseline, reranked, qrels = fixture()
        rows, analysis, _ = combine_rows(baseline, reranked, qrels)
        scores, _ = evaluate_runs(qrels, rows, ["vector", "vector_rerank"])
        self.assertEqual(scores["vector"]["recall@10"], 0)
        self.assertEqual(scores["vector_rerank"]["recall@10"], 1)
        self.assertEqual(scores["vector_rerank"]["ndcg@10"], 1)
        self.assertEqual(analysis[0]["addedRelevant"], [])

    def test_incomplete_duplicate_or_changed_candidates_rejected(self):
        baseline, reranked, qrels = fixture()
        for bad in [reranked[:1], reranked + reranked[:1]]:
            with self.assertRaises(ValueError):
                combine_rows(baseline, bad, qrels)
        reranked[0]["hits"][0] = {"id": "not-in-candidates"}
        with self.assertRaises(ValueError):
            combine_rows(baseline, reranked, qrels)

    def test_candidate_gain_and_loss(self):
        baseline, reranked, _ = fixture()
        hybrid = [{"id": str(i)} for i in range(1, 51)]
        baseline[0]["runs"]["hybrid"] = hybrid
        baseline[0]["runs"]["bm25"] = hybrid
        reranked[1]["hits"] = hybrid
        _, analysis, _ = combine_rows(baseline, reranked, {"q1": {"0": 1, "50": 1}})
        self.assertEqual(analysis[0]["addedRelevant"], ["50"])
        self.assertEqual(analysis[0]["droppedRelevant"], ["0"])

    def test_bootstrap_direction_and_wins(self):
        result = paired_comparison({"a": 0, "b": 1, "c": .5}, {"a": 1, "b": 0, "c": .5}, ["a", "b", "c"])
        self.assertEqual([result[k] for k in ["wins", "ties", "losses"]], [1, 1, 1])
        self.assertEqual(result["meanDelta"], 0)
        positive = paired_comparison({"a": 0}, {"a": 1}, ["a"])
        self.assertEqual(positive["pairedBootstrap95CI"], [1, 1])


if __name__ == "__main__":
    unittest.main()
