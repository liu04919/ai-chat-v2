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

不要在既有目录里改参数覆盖结果；有结果后更换源码/配置会明确报错，需要先归档整个运行目录。重新准备/导入公开数据不意味着可以删除用户业务库。

## 无付费验证

```powershell
pnpm --filter @ai-chat/retrieval-eval typecheck
pnpm exec vitest run evals/retrieval/src/support.test.ts apps/worker/src/knowledge/rerank.test.ts
evals/retrieval/.venv/Scripts/python.exe -m unittest discover -s evals/retrieval -p test_score.py
```

参考：[DuRetrieval](https://huggingface.co/datasets/C-MTEB/DuRetrieval)、[qrels](https://huggingface.co/datasets/C-MTEB/DuRetrieval-qrels)、[ranx](https://github.com/AmenRa/ranx)。
