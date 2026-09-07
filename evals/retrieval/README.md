# 检索层消融实验

业务库和评测库分开，检索实现不分叉。此目录只做数据准备、离线调用与评分，不启动网站、Redis、R2 或聊天模型。

## 实验口径

- 数据：`C-MTEB/DuRetrieval` 完整 corpus（100,001 条 passage），上游 dev 的 2,000 个已标注问题中，按固定种子哈希排序抽取前 100 题。再取不重叠的 20 题供以后调试，未用于本轮调参。不是官方 test，也不是整个 DuReader 原始八百万语料。
- 原样保留 passage 文本和 ID，不重新分块、不截断长文本、不挑选包含答案的小语料库。因此测试的是检索层，不涵盖项目 PDF 解析和 800 字符切块。
- 四组：Vector Top 50；BM25 Top 50；两组经 RRF（k=60）合并后 Top 50；相同混合候选经 Rerank 返回 50 条。`@5/@10` 是评分截断，不是把候选提前缩为 5/10 条。
- 复用 `packages/db/src/knowledge-search.ts` 的 SQL 与执行函数、Worker 的 Embedding、RRF、Rerank。业务默认依旧每路 30、精排 6；评测显式指定 50。
- 一个 corpus 放在一个独立数据库的 `knowledge_chunks`。每条 passage 对应一行，`document_id` 指向评测语料容器；不写 R2。保留账户、知识库、ready 和模型过滤。完整语料入库前拒绝跑正式检索。
- Precision/Recall@5/10、Recall@50、nDCG@10、MRR@10 由 `ranx` 计算；保存逐题排名和指标。原始 SQL 距离是小分在前，转换为严格递减的名次分交给 ranx，避免弄反排序。
- 四组复用同一个 query embedding 和两路候选；这是准确性对照。两条 SQL 并发执行，延迟按阶段观测值组合，不能当作四组独立压测。第一条包含冷缓存影响；不做性能结论。
- qrels 未标注条目按不相关计分，不等于实际无关；100 题存在抽样不确定性，报告包含固定种子的 nDCG@10 配对 bootstrap 区间。不能预设混合或精排一定更高。

## 运行（PowerShell，仓库根目录）

需要 Python 3.13、Node 24.5+、pnpm、正在运行的本项目 PostgreSQL 容器。

```powershell
pnpm install
python -m venv evals/retrieval/.venv
evals/retrieval/.venv/Scripts/python.exe -m pip install -r evals/retrieval/requirements.txt
# 如 Hugging Face 网络需要代理，使用你实际的代理地址。
$env:HTTPS_PROXY='http://127.0.0.1:7890'
evals/retrieval/.venv/Scripts/python.exe evals/retrieval/prepare.py

$env:EVAL_DATABASE_URL='postgres://ai_chat:ai_chat_local@localhost:5433/ai_chat_eval_duretrieval'
$env:EVAL_BUDGET_CNY='20'
$env:EVAL_CONCURRENCY='1'
pnpm --filter @ai-chat/retrieval-eval bench init
pnpm --filter @ai-chat/retrieval-eval bench ingest
pnpm --filter @ai-chat/retrieval-eval bench run
evals/retrieval/.venv/Scripts/python.exe evals/retrieval/score.py --publish
```

只允许本机 `ai_chat_eval_*` 数据库，拒绝业务数据库名；`init` 不删除数据库。付费接口读取 Worker 被 Git 忽略的 `.env.local`，不要把 Key 写进脚本或报告。模型固定 `qwen3.7-text-embedding`（1024 维）和 `qwen3.7-text-rerank`，不调用聊天/图片渠道。

本轮两种模型按北京原价 **¥0.5/百万输入 token** 预算，不假设免费额度，最高 ¥20。请求前按 UTF-8 字节数加余量预留，成功按 API usage 结算；失败、缺失用量或进程中断保留预留。账本跨重启累积，绝不是每次启动重新给 ¥20。记录的是预算估算，不是云账单；换模型/地域/单价前须重新核对预算逻辑。[Embedding 价格](https://help.aliyun.com/zh/model-studio/qwen3-7-text-embedding)、[Rerank 价格](https://help.aliyun.com/zh/model-studio/qwen3-7-text-rerank)。

首次 corpus 向量化耗时较长；评测使用该模型支持的每批 20 条，数据库已存向量即为断点，重启只处理缺失 ID。遇到错误停止派发，无自动重试和隐式降级；人工检查 `failures.jsonl` 后可重新运行。异常终止留下 `runner.lock` 时，必须先确认旧进程已结束，再删除该锁；不允许两个进程并发消费同一预算目录。未完成全部选定问题时，评分程序拒绝给正式平均分。

## 输出

本地大文件和虚拟环境已被 Git 忽略，位于 `artifacts/duretrieval/`：

- `manifest.json`：数据源固定提交、Parquet SHA256、准备后文件 SHA256、抽题种子、文本规模。
- `database.json`：库名、corpus/模型/维度指纹；配置不一致拒绝复用向量。
- `usage.jsonl`、`cost.json`：逐请求预算账本和总量；`failures.jsonl` 保留失败尝试，不因恢复成功而删除。
- `run.json`：检索参数、源码 SHA256、Git 提交及 dirty 标记、扩展版本。
- `results.jsonl`：逐题四组排名、原始分数、阶段耗时、精排用量/请求 ID；不记录密钥。
- `plans.json`：真实执行计划，不强制索引，不使用单独的示例 SQL。
- `report.md/json`、`per-query-metrics.json`：ranx 汇总和逐题指标。报告可提交，完整数据需遵循原始数据集许可，不随代码分发。

`score.py --publish` 另外把报告、来源参数和逐题指标归档到 `reports/<运行时间>/`，可随代码提交，不包含文档正文或密钥。原始排名文件保留在本地 artifacts。

## 补测：纯向量＋精排 vs 混合＋精排

运行 `rerank-ablation` 复用上述完整实验的原始候选和 passage，不重新调用 Embedding、不连接数据库，也不覆盖旧排名或旧报告。两组均使用 50 条候选、相同模型、本轮新调用精排，逐题交替调用先后顺序；仅重排，不改写问题、不截断原文。这是固定精排预算的对照，不是完整候选并集实验。

```powershell
pnpm --filter @ai-chat/retrieval-eval rerank-ablation estimate
pnpm --filter @ai-chat/retrieval-eval rerank-ablation run
evals/retrieval/.venv/Scripts/python.exe evals/retrieval/rerank_score.py --publish
```

- 补测输出独立保存在 `artifacts/duretrieval-rerank-ablation/`，报告归档到 `reports/rerank-ablation-<时间>/`。保留基线、运行源码和评分代码的 SHA256；输入或运行代码变化时拒绝续跑，不覆盖原实验。
- 与原实验共用 `artifacts/duretrieval/runner.lock` 和 `usage.jsonl`，累计上限仍为 ¥20，不重新发放预算。`estimate` 输出所有请求保守预留之和，不是预计账单；实际逐请求检查预算，成功按 usage 结算。补测目录 `cost.json` 同时记录新增和累计记账，原目录 `cost.json` 保留旧报告时点的值。
- 每完成一次精排保存断点，已完成的 query/arm 不再调用；失败保留预算预留、写入失败记录并退出，没有自动重试。确认原因后重新运行同一命令即可续跑。两组未覆盖全部问题时拒绝评分。
- `rerank_score.py` 复用 ranx，核对旧排名重算成绩与旧报告一致，保存五组指标、逐题胜平负、配对 bootstrap 区间、BM25 新增/丢失相关候选及旧混合精排重跑稳定性。新测耗时仅含精排请求，不包装成完整检索延迟或吞吐压测。

2026-09-07 补测：纯向量＋精排 nDCG@10 **0.9309**，混合＋精排 **0.9258**；混合减纯向量的 95% CI 为 **[-0.0165, +0.0043]**，逐题胜/平/负 **4/90/6**。本样本未证明 BM25 在精排之后有稳定增益；不能推导为 BM25 普遍无用。精排相对各自未精排版本的收益仍然成立。详见 [补测报告](reports/rerank-ablation-2026-09-07T04-06-07-943Z/report.md)。

补测无付费验证：

```powershell
pnpm exec vitest run evals/retrieval/src/rerank-ablation-support.test.ts evals/retrieval/src/support.test.ts apps/worker/src/knowledge/rerank.test.ts
evals/retrieval/.venv/Scripts/python.exe -m unittest discover -s evals/retrieval -p 'test_*.py'
```

不要在既有目录里改参数覆盖结果；有结果后更换源码/配置会明确报错，需要先归档整个运行目录。重新准备/导入公开数据不意味着可以删除用户业务库。

## 无付费验证

```powershell
pnpm --filter @ai-chat/retrieval-eval typecheck
pnpm exec vitest run evals/retrieval/src/support.test.ts apps/worker/src/knowledge/rerank.test.ts
evals/retrieval/.venv/Scripts/python.exe -m unittest discover -s evals/retrieval -p test_score.py
```

参考：[DuRetrieval](https://huggingface.co/datasets/C-MTEB/DuRetrieval)、[qrels](https://huggingface.co/datasets/C-MTEB/DuRetrieval-qrels)、[ranx](https://github.com/AmenRa/ranx)。
