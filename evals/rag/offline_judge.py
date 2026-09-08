"""Export native Ragas prompts, validate blind judgments, replay native metrics.

No API calls. The external executor is recorded separately from Ragas algorithms.
"""
import argparse
import asyncio
import hashlib
import json
from pathlib import Path

from score import ROOT, read, lines, InstructorBaseRagasLLM, Faithfulness, AnswerAccuracy
from ragas.metrics.collections.faithfulness.util import (
    StatementGeneratorInput, StatementGeneratorOutput, NLIStatementInput, NLIStatementOutput,
)
from ragas.metrics.collections.answer_accuracy.util import AnswerAccuracyInput, AnswerAccuracyOutput

PROTOCOL = "ragas-0.4.3-codex-blind-v1"


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def save(path, value):
    content = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text(encoding="utf-8") != content:
        raise ValueError("FROZEN_ARTIFACT_CHANGED")
    path.write_text(content, encoding="utf-8")


def answer_rows(split, available=False):
    manifest = read("manifest.json")
    for name, sha in manifest["files"].items():
        if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != sha:
            raise ValueError("DATASET_HASH_MISMATCH")
    expected = read(f"{split}.json")
    answers = {r["id"]: r for r in lines(f"{split}-answers.jsonl")}
    if set(answers) != {q["id"] for q in expected}:
        raise ValueError("COMPLETE_ANSWER_SET_REQUIRED")
    if not available and any(not r["ok"] or not r["sources"] for r in answers.values()):
        raise ValueError("SUCCESSFUL_ANSWERS_REQUIRED")
    return [answers[q["id"]] for q in expected if answers[q["id"]]["ok"] and answers[q["id"]]["sources"]]


def request(row, phase, prompt, schema):
    return {"requestId": digest([PROTOCOL, prompt, schema.model_json_schema()]),
            "sample": digest(row["id"])[:16], "phase": phase,
            "prompt": prompt, "outputSchema": schema.model_json_schema()}


def load_outputs(folder):
    outputs = {}
    for path in sorted(folder.glob("*.outputs.json")):
        for row in json.loads(path.read_text(encoding="utf-8")):
            if row["requestId"] in outputs:
                raise ValueError("DUPLICATE_JUDGMENT")
            outputs[row["requestId"]] = row["output"]
    return outputs


def validate_output(phase, output):
    model = {"statements": StatementGeneratorOutput, "accuracy": AnswerAccuracyOutput, "nli": NLIStatementOutput}[phase]
    result = model.model_validate(output)
    if phase == "accuracy" and result.rating not in [0, 2, 4]:
        raise ValueError("INVALID_RATING")
    if phase == "statements" and (not result.statements or any(not s.strip() for s in result.statements)):
        raise ValueError("EMPTY_STATEMENTS")
    if phase == "nli" and (not result.statements or any(s.verdict not in [0, 1] for s in result.statements)):
        raise ValueError("INVALID_NLI_VERDICT")
    return result


def build_requests(answers, phase, outputs):
    faithful, accuracy = Faithfulness(llm=Replay({})), AnswerAccuracy(llm=Replay({}), max_retries=1)
    requests = []
    for row in answers:
        statement = request(row, "statements", faithful.statement_generator_prompt.to_string(
            StatementGeneratorInput(question=row["question"], answer=row["answer"])), StatementGeneratorOutput)
        if phase == "statements":
            requests.append(statement)
        elif phase == "accuracy":
            ref = row["referenceAnswers"][0]
            for prompt, answer, reference in [
                (accuracy.judge1_prompt, row["answer"], ref),
                (accuracy.judge2_prompt, ref, row["answer"]),
            ]:
                requests.append(request(row, "accuracy", prompt.to_string(
                    AnswerAccuracyInput(query=row["question"], user_answer=answer, reference_answer=reference)), AnswerAccuracyOutput))
        else:
            if statement["requestId"] not in outputs:
                raise ValueError("STATEMENT_JUDGMENT_REQUIRED")
            statements = validate_output("statements", outputs[statement["requestId"]]).statements
            requests.append(request(row, "nli", faithful.nli_statement_prompt.to_string(
                NLIStatementInput(context="\n".join(s["content"] for s in row["sources"]), statements=statements)), NLIStatementOutput))
    return requests


class Replay(InstructorBaseRagasLLM):
    def __init__(self, outputs):
        self.outputs = outputs
        self.used = []

    def generate(self, prompt, response_model):
        raise NotImplementedError("ASYNC_ONLY")

    async def agenerate(self, prompt, response_model):
        key = digest([PROTOCOL, prompt, response_model.model_json_schema()])
        if key not in self.outputs:
            raise ValueError("JUDGMENT_MISSING")
        phase = {StatementGeneratorOutput: "statements", NLIStatementOutput: "nli", AnswerAccuracyOutput: "accuracy"}[response_model]
        result = validate_output(phase, self.outputs[key])
        self.used.append((phase, result))
        return result


async def replay(answers, outputs):
    rows = []
    for row in answers:
        llm = Replay(outputs)
        faith = await Faithfulness(llm=llm).ascore(user_input=row["question"], response=row["answer"], retrieved_contexts=[s["content"] for s in row["sources"]])
        if len(llm.used) != 2 or llm.used[0][1].statements != [s.statement for s in llm.used[1][1].statements]:
            raise ValueError("NLI_MUST_COVER_EACH_STATEMENT_IN_ORDER")
        acc = await AnswerAccuracy(llm=llm, max_retries=1).ascore(user_input=row["question"], response=row["answer"], reference=row["referenceAnswers"][0])
        if len(llm.used) != 4:
            raise ValueError("FOUR_NATIVE_JUDGMENTS_REQUIRED")
        rows.append({"id": row["id"], "answerSha256": hashlib.sha256(row["answer"].encode()).hexdigest(),
                     "faithfulness": faith.value, "answer_accuracy": acc.value,
                     "judge": "gpt-6-astra", "executor": "Codex fresh-context subagents", "protocol": PROTOCOL, "ragas": "0.4.3"})
    return rows


def main(args):
    answers = answer_rows(args.split, available=args.action == "validate" or (args.available and args.action == "export"))
    folder = ROOT / "offline" / args.split
    outputs = load_outputs(folder)
    if args.action == "export":
        if args.available and args.phase == "nli":
            answers = [r for r in answers if build_requests([r], "statements", {})[0]["requestId"] in outputs]
        requests = build_requests(answers, args.phase, outputs)
        exported = {r["requestId"] for path in folder.glob("*.requests.json")
                    for r in json.loads(path.read_text(encoding="utf-8"))["requests"]}
        requests = [r for r in requests if r["requestId"] not in outputs and r["requestId"] not in exported]
        for offset in range(0, len(requests), args.batch_size):
            batch = requests[offset:offset + args.batch_size]
            suffix = "-" + digest([r["requestId"] for r in batch])[:8] if args.available else ""
            name = f"{args.phase}-{offset // args.batch_size:02d}{suffix}.requests.json"
            save(folder / name, {"protocol": PROTOCOL, "requests": batch})
            print(name)
        print(f"Exported {len(requests)} native {args.phase} prompts")
    elif args.action == "validate":
        required = {}
        for path in folder.glob("*.requests.json"):
            for req in json.loads(path.read_text(encoding="utf-8"))["requests"]:
                required[req["requestId"]] = req["phase"]
        for key, output in outputs.items():
            if key not in required:
                raise ValueError("UNEXPECTED_JUDGMENT_ID")
            validate_output(required[key], output)
        print(json.dumps({"required": len(required), "received": len(outputs), "missing": len(set(required) - set(outputs))}))
    else:
        scores = asyncio.run(replay(answers, outputs))
        save(folder / "scores.json", scores)
        save(folder / "judgment-manifest.json", {
            "protocol": PROTOCOL, "judgeRequested": "gpt-6-astra", "forkTurns": "none",
            "metricRuntime": "ragas==0.4.3", "sampleCount": len(scores),
            "judgmentCount": len(scores) * 4,
            "files": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                      for p in sorted(folder.glob("*.json")) if p.name != "judgment-manifest.json"},
            "limitations": ["Fresh context per batch/phase, shared context within each batch",
                            "Codex usage is separate from relay API CNY accounting",
                            "Configured model selection is recorded; no independent model identity attestation"],
        })
        print(json.dumps({"count": len(scores), "faithfulness": sum(r["faithfulness"] for r in scores) / len(scores),
                          "answerAccuracy": sum(r["answer_accuracy"] for r in scores) / len(scores)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["export", "validate", "replay"])
    parser.add_argument("split", choices=["pilot", "test"])
    parser.add_argument("--phase", choices=["statements", "accuracy", "nli"], default="statements")
    parser.add_argument("--batch-size", type=int, choices=range(1, 51), default=10)
    parser.add_argument("--available", action="store_true", help="Export ready answers only; replay still requires the complete fixed test set")
    main(parser.parse_args())
