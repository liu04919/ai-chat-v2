"""下载固定版本的公开 passage/qrels；不重切块、不删长文本、不混入业务库。"""
import hashlib
import json
from pathlib import Path

import pyarrow.parquet as pq
import requests

ROOT = Path(__file__).resolve().parent / "artifacts" / "duretrieval"
ROOT.mkdir(parents=True, exist_ok=True)
SESSION = requests.Session()
REVISIONS = {
    "C-MTEB/DuRetrieval": "a1a333e290fe30b10f3f56498e3a0d911a693ced",
    "C-MTEB/DuRetrieval-qrels": "497b7bd1bbb25cb3757ff34d95a8be50a3de2279",
}
CHECKSUMS = {
    "data/corpus-00000-of-00001-19b9e924cb33e4d5.parquet": "d4b4eb51b63549ef0851a15fc63c2a61b703dce95e3727b535a08f7ba1d14424",
    "data/queries-00000-of-00001-7c7edb40be6b560c.parquet": "62ac55e764bffd4ffceb0aa51e7a536a0e5932f23c8606566906db6a9efb4b94",
    "data/dev-00000-of-00001-d3c385852a7c0c9d.parquet": "c87e7c16f535a98b29ee0ebf6977639c793e3bd149c04634a1810273cfd3c3e5",
}


def get_json(url):
    response = SESSION.get(url, timeout=120)
    response.raise_for_status()
    return response.json()


def dataset(repo):
    revision = REVISIONS[repo]
    metadata = get_json(f"https://huggingface.co/api/datasets/{repo}/revision/{revision}")
    assert metadata["sha"] == revision
    files = [x["rfilename"] for x in metadata["siblings"] if x["rfilename"].endswith(".parquet")]
    result = {}
    sources = []
    for name in files:
        target = ROOT / (repo.split("/")[-1] + "-" + name.replace("/", "-"))
        url = f"https://huggingface.co/datasets/{repo}/resolve/{revision}/{name}"
        if not target.exists():
            with SESSION.get(url, stream=True, timeout=180) as response:
                response.raise_for_status()
                with target.with_suffix(".partial").open("wb") as output:
                    for chunk in response.iter_content(1024 * 1024):
                        output.write(chunk)
            target.with_suffix(".partial").replace(target)
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        if digest != CHECKSUMS[name]:
            raise ValueError(f"Parquet SHA256 mismatch: {name}")
        rows = pq.read_table(target).to_pylist()
        result.setdefault(name.split("/")[-1].split("-")[0], []).extend(rows)
        sources.append({"url": url, "sha256": digest, "rows": len(rows)})
        print(name, len(rows), flush=True)
    return result, {"repo": repo, "revision": revision, "files": sources, "cardData": metadata.get("cardData")}


def main():
    data, source = dataset("C-MTEB/DuRetrieval")
    judgments, qsource = dataset("C-MTEB/DuRetrieval-qrels")
    corpus, queries = data["corpus"], data["queries"]
    ids = {str(row["id"]) for row in corpus}
    assert len(ids) == len(corpus) and len(corpus) >= 100000
    assert all(isinstance(row["text"], str) and row["text"].strip() for row in corpus)
    qrels = {}
    for row in judgments["dev"]:
        assert str(row["pid"]) in ids
        qrels.setdefault(str(row["qid"]), {})[str(row["pid"])] = int(row["score"])
    assert len({str(row["id"]) for row in queries}) == len(queries)
    assert set(qrels) <= {str(row["id"]) for row in queries}
    # 固定种子哈希排序，抽题不查看检索结果。前 100 题评估，后 20 题仅作调试。
    seed = "ai-chat-duretrieval-v1"
    ordered = sorted((row for row in queries if str(row["id"]) in qrels), key=lambda r: hashlib.sha256((seed + str(r["id"])).encode()).hexdigest())
    selected = [{"id": str(r["id"]), "text": r["text"]} for r in ordered[:100]]
    for name, rows in [("corpus", corpus), ("queries", selected), ("debug-queries", ordered[100:120])]:
        with (ROOT / f"{name}.jsonl").open("w", encoding="utf8", newline="\n") as output:
            for row in rows:
                output.write(json.dumps({"id": str(row["id"]), "text": row["text"]}, ensure_ascii=False) + "\n")
    selected_qrels = {r["id"]: qrels[r["id"]] for r in selected}
    (ROOT / "qrels.json").write_text(json.dumps(selected_qrels, ensure_ascii=False), encoding="utf8")
    lengths = sorted(len(r["text"]) for r in corpus)
    manifest = {"dataset": source, "qrels": qsource, "seed": seed, "corpusCount": len(corpus), "queryCount": len(queries), "judgedQueryCount": len(qrels), "evaluationQueries": len(selected), "split": "fixed subset of upstream dev; not official test", "textPolicy": "original passage, unchanged", "characters": sum(lengths), "utf8Bytes": sum(len(r["text"].encode()) for r in corpus), "maxCharacters": lengths[-1], "p95Characters": lengths[int(len(lengths)*.95)], "files": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in ["corpus.jsonl", "queries.jsonl", "qrels.json"]}}
    (ROOT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf8")
    print(json.dumps({k: v for k, v in manifest.items() if k not in ["dataset", "qrels", "files"]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
