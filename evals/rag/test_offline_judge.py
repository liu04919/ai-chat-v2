import asyncio
import unittest
from offline_judge import build_requests, replay, validate_output


class OfflineJudgeTests(unittest.TestCase):
    def fixture(self):
        row = {"id": "q1", "question": "城市在哪？", "answer": "城市在法国。人口一百万。",
               "referenceAnswers": ["法国"], "sources": [{"content": "城市在法国。"}]}
        answers = [row]
        outputs = {}
        statements = build_requests(answers, "statements", outputs)[0]
        outputs[statements["requestId"]] = {"statements": ["城市在法国。", "人口一百万。"]}
        for req in build_requests(answers, "accuracy", outputs):
            outputs[req["requestId"]] = {"rating": 2}
        nli = build_requests(answers, "nli", outputs)[0]
        outputs[nli["requestId"]] = {"statements": [
            {"statement": "城市在法国。", "reason": "原文支持", "verdict": 1},
            {"statement": "人口一百万。", "reason": "原文未提供人口", "verdict": 0},
        ]}
        return answers, outputs, nli

    def test_native_metrics_replay(self):
        answers, outputs, _ = self.fixture()
        result = asyncio.run(replay(answers, outputs))[0]
        self.assertEqual(result["faithfulness"], 0.5)
        self.assertEqual(result["answer_accuracy"], 0.5)

    def test_missing_accuracy_judge_cannot_use_ragas_single_judge_fallback(self):
        answers, outputs, _ = self.fixture()
        del outputs[build_requests(answers, "accuracy", outputs)[0]["requestId"]]
        with self.assertRaisesRegex(ValueError, "FOUR_NATIVE_JUDGMENTS_REQUIRED"):
            asyncio.run(replay(answers, outputs))

    def test_missing_or_rewritten_statement_rejected(self):
        answers, outputs, nli = self.fixture()
        outputs[nli["requestId"]]["statements"][0]["statement"] = "被篡改"
        with self.assertRaisesRegex(ValueError, "NLI_MUST_COVER"):
            asyncio.run(replay(answers, outputs))

    def test_invalid_discrete_rating_rejected(self):
        with self.assertRaisesRegex(ValueError, "INVALID_RATING"):
            validate_output("accuracy", {"rating": 3})


if __name__ == "__main__":
    unittest.main()
