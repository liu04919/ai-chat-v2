"""Ragas scores persisted website answers; never invent answers or hide failed rows."""
import argparse
import asyncio
import hashlib
import json
import math
import os
import traceback
import re
from pathlib import Path

os.environ["RAGAS_DO_NOT_TRACK"] = "true"
os.environ["LANGCHAIN_TRACING_V2"] = "false"

from openai import AsyncOpenAI
import httpx
from ragas.llms.base import InstructorBaseRagasLLM
from ragas.metrics.collections import Faithfulness, AnswerAccuracy

ROOT = Path(__file__).resolve().parent / "artifacts" / "cmrc2018"


class ResponsesJudge(InstructorBaseRagasLLM):
    """仅适配协议；评分提示、Pydantic schema 和计分算法仍由 Ragas 提供。"""

    def __init__(self, client, model):
        self.client = client
        self.model = model

    def generate(self, prompt, response_model):
        raise NotImplementedError("ASYNC_JUDGE_REQUIRED")

    async def agenerate(self, prompt, response_model):
        stream = await self.client.responses.create(
            model=self.model, input=prompt, store=False, stream=True,
            reasoning={"effort": "low"}, max_output_tokens=8192,
            text={"format": {"type": "json_schema", "name": response_model.__name__,
                             "schema": response_model.model_json_schema(), "strict": False}},
        )
        pieces = []
        completed = False
        async with stream:
            async for event in stream:
                if event.type == "response.output_text.delta":
                    pieces.append(event.delta)
                elif event.type == "response.completed":
                    completed = True
                elif event.type in {"response.failed", "response.incomplete", "error"}:
                    detail = getattr(getattr(event, "response", None), "error", None)
                    code = str(getattr(detail, "code", "unknown"))
                    message = str(getattr(detail, "message", "")).lower()
                    if re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", code):
                        print(f"JUDGE_UPSTREAM_CODE: {code}", flush=True)
                    for marker in ["overloaded", "json_schema", "not supported", "model", "rate limit"]:
                        if marker in message:
                            print(f"JUDGE_UPSTREAM_HINT: {marker}", flush=True)
                    raise ValueError("JUDGE_STREAM_FAILED")
        if not completed:
            raise ValueError("JUDGE_STREAM_INCOMPLETE")
        # 只剥离完整代码围栏，不修补或猜测评分。
        raw = "".join(pieces).strip()
        if raw.startswith("```json\n") and raw.endswith("```"):
            raw = raw[8:-3].strip()
        return response_model.model_validate_json(raw)


def read(name):
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def lines(name):
    path = ROOT / name
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line] if path.exists() else []


def append(name, value):
    with (ROOT / name).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")


async def main(split, judge):
    runtime = read("runtime.json")
    if not runtime["meterUrl"].startswith("http://127.0.0.1:"):
        raise ValueError("LOCAL_BUDGET_METER_REQUIRED")
    manifest = read("manifest.json")
    for name, digest in manifest["files"].items():
        if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != digest:
            raise ValueError("DATASET_HASH_MISMATCH")
    expected = read(f"{split}.json")
    # 原始尝试全部保留；恢复后只给每题最新回答评分，报告另算首次成功率。
    answers = list({r["id"]: r for r in lines(f"{split}-answers.jsonl")}.values())
    if len(answers) != len(expected) or {r["id"] for r in answers} != {q["id"] for q in expected}:
        raise ValueError("COMPLETE_ANSWER_SET_REQUIRED")
    scored = {row["id"]: row for row in lines(f"{split}-scores.jsonl")}
    if any(row["judge"] != judge for row in scored.values()):
        raise ValueError("MIXED_JUDGES_NOT_ALLOWED")
    if any(row["id"] in scored and scored[row["id"]].get("answerSha256") != hashlib.sha256(row["answer"].encode()).hexdigest() for row in answers):
        raise ValueError("SCORED_ANSWER_CHANGED")
    cached = {r["cacheKey"]: r["output"] for r in lines(f"{split}-judge-trace.jsonl") if "cacheKey" in r}
    client = AsyncOpenAI(base_url=runtime["meterUrl"] + "/llm", api_key=runtime["meterToken"], max_retries=0, timeout=180,
                         http_client=httpx.AsyncClient(trust_env=False, timeout=180))
    semaphore = asyncio.Semaphore(2)
    failures = []

    async def score_row(row):
        current = {"id": row["id"], "metric": ""}
        outputs = []
        llm = ResponsesJudge(client, judge)
        generate = llm.agenerate

        async def audited_generate(prompt, response_model):
            key = hashlib.sha256(json.dumps([judge, "responses-json-schema-v1", prompt, response_model.model_json_schema()], sort_keys=True).encode()).hexdigest()
            result = response_model.model_validate(cached[key]) if key in cached else await generate(prompt, response_model)
            outputs.append(result.model_dump())
            if key not in cached:
                append(f"{split}-judge-trace.jsonl", {**current, "judge": judge, "cacheKey": key, "prompt": prompt, "output": result.model_dump()})
                cached[key] = result.model_dump()
            return result

        llm.agenerate = audited_generate
        faithfulness = Faithfulness(llm=llm)
        accuracy = AnswerAccuracy(llm=llm, max_retries=1)
        if not row["ok"] or not row["sources"]:
            raise ValueError("FAILED_ANSWER_REQUIRES_INSPECTION")
        current["metric"] = "faithfulness"
        before = len(outputs)
        faithful = await faithfulness.ascore(user_input=row["question"], response=row["answer"], retrieved_contexts=[s["content"] for s in row["sources"]])
        faith_outputs = outputs[before:]
        if len(faith_outputs) != 2 or not faith_outputs[0]["statements"] or len(faith_outputs[0]["statements"]) != len(faith_outputs[1]["statements"]) or any(s["verdict"] not in [0, 1] for s in faith_outputs[1]["statements"]):
            raise ValueError("COMPLETE_FAITHFULNESS_JUDGMENTS_REQUIRED")
        current["metric"] = "answer_accuracy"
        before = len(outputs)
        # 固定使用上游第一份人工答案，保留全部备选答案供人工复核，不事后挑最高分。
        accurate = await accuracy.ascore(user_input=row["question"], response=row["answer"], reference=row["referenceAnswers"][0])
        if len(outputs) - before != 2 or any(x.get("rating") not in [0, 2, 4] for x in outputs[before:]):
            raise ValueError("BOTH_ACCURACY_JUDGMENTS_REQUIRED")
        if not all(math.isfinite(x) for x in [faithful.value, accurate.value]):
            raise ValueError("JUDGE_NONFINITE_SCORE")
        result = {"id": row["id"], "answerSha256": hashlib.sha256(row["answer"].encode()).hexdigest(), "faithfulness": faithful.value, "answer_accuracy": accurate.value,
                  "judge": judge, "ragas": "0.4.3", "referencePolicy": "first human answer", "language": "Chinese data, upstream English judge prompts"}
        append(f"{split}-scores.jsonl", result)
        print(json.dumps(result, ensure_ascii=False), flush=True)

    async def bounded_score(row):
        if row["id"] in scored:
            return
        async with semaphore:
            try:
                await score_row(row)
            except Exception as error:
                # 继续其余题，但整轮返回失败，不发布缺题的平均分。
                failure = {"id": row["id"], "judge": judge, "errorType": type(error).__name__}
                append(f"{split}-judge-failures.jsonl", failure)
                failures.append(failure)
                print(json.dumps(failure), flush=True)

    try:
        await asyncio.gather(*(bounded_score(row) for row in answers))
        if failures:
            raise ValueError("INCOMPLETE_SCORING_REQUIRES_INSPECTION")
    finally:
        await client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("split", choices=["pilot", "test"])
    parser.add_argument("--judge", choices=["gpt-6-astra", "gpt-5.6-sol"], default="gpt-6-astra")
    args = parser.parse_args()
    lock = ROOT / "scorer.lock"
    with lock.open("x"):
        pass
    try:
        asyncio.run(main(args.split, args.judge))
    except Exception as error:
        # 第三方 SDK 异常可能包含请求正文/凭证，控制台只给类型和失败标记。
        print(f"RAGAS_SCORING_FAILED: {type(error).__name__}", flush=True)
        for frame in traceback.extract_tb(error.__traceback__)[-4:]:
            print(f"  {Path(frame.filename).name}:{frame.lineno} {frame.name}", flush=True)
        if type(error) is ValueError and str(error) in {"JUDGE_STREAM_FAILED", "JUDGE_STREAM_INCOMPLETE", "BOTH_ACCURACY_JUDGMENTS_REQUIRED", "JUDGE_NONFINITE_SCORE", "FAILED_ANSWER_REQUIRES_INSPECTION", "COMPLETE_ANSWER_SET_REQUIRED"}:
            print(str(error), flush=True)
        raise SystemExit(1)
    finally:
        lock.unlink()
