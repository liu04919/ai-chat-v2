"""Protocol-only tests: no network requests and no paid model calls."""
import unittest
from types import SimpleNamespace
from pydantic import BaseModel, ValidationError
from score import ResponsesJudge


class Rating(BaseModel):
    rating: int


class FakeStream:
    def __init__(self, events):
        self.events = events

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def __aiter__(self):
        for event in self.events:
            yield SimpleNamespace(**event)


class JudgeProtocolTests(unittest.IsolatedAsyncioTestCase):
    def judge(self, events):
        async def create(**kwargs):
            self.assertTrue(kwargs["stream"])
            self.assertEqual(kwargs["max_output_tokens"], 8192)
            self.assertEqual(kwargs["text"]["format"]["schema"], Rating.model_json_schema())
            return FakeStream(events)
        return ResponsesJudge(SimpleNamespace(responses=SimpleNamespace(create=create)), "gpt-5.6-sol")

    async def test_valid_completed_json(self):
        result = await self.judge([
            {"type": "response.output_text.delta", "delta": '{"rating":'},
            {"type": "response.output_text.delta", "delta": '4}'},
            {"type": "response.completed"},
        ]).agenerate("native Ragas prompt", Rating)
        self.assertEqual(result.rating, 4)

    async def test_partial_json_is_not_a_completed_judgment(self):
        with self.assertRaisesRegex(ValueError, "JUDGE_STREAM_INCOMPLETE"):
            await self.judge([{"type": "response.output_text.delta", "delta": '{"rating":4}'}]).agenerate("prompt", Rating)

    async def test_upstream_failure_not_zero_score(self):
        with self.assertRaisesRegex(ValueError, "JUDGE_STREAM_FAILED"):
            await self.judge([{"type": "response.failed"}]).agenerate("prompt", Rating)

    async def test_malformed_json_not_repaired(self):
        with self.assertRaises(ValidationError):
            await self.judge([
                {"type": "response.output_text.delta", "delta": "I think four"},
                {"type": "response.completed"},
            ]).agenerate("prompt", Rating)


if __name__ == "__main__":
    unittest.main()
