# Agentic RAG 对照评测

这是独立评测代码，不向业务添加传统模式。传统代码固定在 Git `7134eb0` 的 detached worktree；Agentic 代码固定在 `9e55d20`。本轮未修改业务模型指令、检索参数或工具实现。

## 预先确定的口径

- 主对照复用 CMRC 2018 的同一 5 道试跑题、50 道测试题、848 篇原文和 948 个分块。沿用已完成真实 HTTP 入库的隔离数据库，不重新上传、不重复向量化。这个测试集已被我们检查过，因此叫固定回归对照，不宣称全新未知测试集。
- 两版都走 `localhost:3301` 的真实认证、Generation API、Worker、SSE 和落库回答核验；顺序启动，共用既有评测数据库和 Redis 14，不允许两个评测 Worker 同时消费。业务开发实例不参与。
- 两版都用本地 Codex Proxy 的 `gpt-5.6-sol / medium`，每次 Responses 请求限制 8192 输出 token，不修改业务 prompt。Agentic 的额外调用与上下文是方案成本的一部分，不能宣传成相同计算量下的比较。
- Embedding 与精排共同使用持久化 ¥10 预算，失败或缺失 usage 保留预留。文本请求必须指向本机 `127.0.0.1:8080/v1` 才能使用订阅记账，不能拿“免费模式”访问付费远端。订阅请求单独记录全部模型调用和 token，不折算人民币。
- 工具只允许 `search_knowledge` 函数；不开放联网、MCP、生图或远程保存的会话。Query 和结果轨迹只从隔离评测数据库中已记录的 Generation 提取，不放到业务 SSE。
- 答案生成完后再正式评分，避免评分并发影响主对照生成延迟。Astra 通过同一本地 Proxy，使用 `score.py` 的 Ragas 0.4.3 原始 `Faithfulness` / `AnswerAccuracy` 提示、schema 和计分。每个判断是独立请求，不传上一次 response ID；评委不接触方案名、既有成绩或研究目标。准确性两个提示仍是同一个模型，不是两名独立评委。
- 评分器的协议适配使用显式 `input_text` 消息数组。本次 Proxy 不接受字符串形式 `input`；失败试跑记录保留，不记成质量 0 分。没有改写或修补评分输出。
- 首次生成成功率与重试后质量必须分开；无完整 50 题和对应分数时不发布主对照平均分。未知 token 不冒充零用量。

## 主要指标

AnswerAccuracy、Faithfulness、累计来源中的已知答案区间命中、引用格式合法性、首次生成成功率、首正文/总耗时、知识库工具调用数和全部 Sol 请求 token。对逐题质量差值做配对 bootstrap，而不是比较两组不配对区间。

Agentic 最多三次检索、最多十八条累计来源，传统一次六条。因此累计来源命中率不是相同 k 的 Recall@6，更不是相关片段完整标注下的 Recall。首次正文可能是调用工具前的说明，并不等于最终答案可用时间；需要同时看总耗时。引用格式合法不代表对应句子被该引用支持。

## 专项回归

`src/agentic-cases.ts` 固定 12 个手工案例：问候、计算、语义改写、精确事实、跨记录/多跳查证、缺失资料、多轮指代、文档提示注入。用虚构资料减少模型预训练记忆的影响。所有期望在运行前固定。

只有主对照两版 50 题全部完成后，才能导入专项资料，避免改变主对照的共享 BM25 统计。专项走真实预签名上传与入库。输出中的字符串断言仅是回归烟测，不能冒充语义准确率或公开 benchmark；需要检查回答和实际工具轨迹。若一次检索已经得到充分证据，正确回答不要求为了展示能力而多次调用工具。

## 命令

先确保旧隔离评测数据仍在、原 host 已停止、本地 Proxy 已启动：

```powershell
git worktree add --detach evals/rag/artifacts/agentic-v1/traditional-code 7134eb0
pnpm --dir evals/rag/artifacts/agentic-v1/traditional-code install --offline --ignore-scripts --frozen-lockfile
pnpm --filter @ai-chat/rag-eval compare:prepare

$env:RAG_EVAL_VARIANT='traditional'
pnpm --filter @ai-chat/rag-eval host
# 另一个终端设置相同 RAG_EVAL_VARIANT：
pnpm --filter @ai-chat/rag-eval bench pilot
pnpm --filter @ai-chat/rag-eval bench test --continue-on-failure
pnpm --filter @ai-chat/rag-eval exec tsx src/capture-traces.ts
# Ctrl+C 关闭该 host；改成 agentic 重复上述启动/生成。
```

两版生成完成后可用仍运行的 Agentic host 给两版回答评分：

```powershell
$env:RAG_EVAL_VARIANT='traditional' # 决定被评答案和评分输出目录
$env:RAG_EVAL_JUDGE_VARIANT='agentic' # 仅选择正在运行的预算入口
evals/rag/.venv/Scripts/python.exe evals/rag/score.py test
$env:RAG_EVAL_VARIANT='agentic'
evals/rag/.venv/Scripts/python.exe evals/rag/score.py test
pnpm --filter @ai-chat/rag-eval exec tsx src/run-agentic-cases.ts
pnpm --filter @ai-chat/rag-eval exec tsx src/compare-report.ts --publish
```

原始数据、凭证、工具轨迹和订阅账本留在被忽略的 `artifacts/agentic-v1/`，不要分享整个目录。发布报告只导出公开题目、回答、指标与实验口径。不自动删除 worktree、数据库、对象文件，不自动推送。

## 来源上限修复后的独立重跑

旧 Agentic 批次 43/50 成功，七次因为 SSE 来源上限仍为 6 而失败。经确认已让 SSE 复用消息来源 schema（最多 18）；没有调整模型指令或检索参数。
修复未提交，因此用原 Git commit + 精确 patch SHA-256 标识，记录在 `agentic-fixed/revision.json`。旧 `agentic/` 目录不移动、不覆盖；付费预算仍累计原 `usage.jsonl`。

```powershell
pnpm --filter @ai-chat/rag-eval exec tsx src/prepare-source-fix.ts
$env:RAG_EVAL_VARIANT='agentic-fixed'
pnpm --filter @ai-chat/rag-eval host
# 另一个终端设置相同 RAG_EVAL_VARIANT：
pnpm --filter @ai-chat/rag-eval bench pilot
pnpm --filter @ai-chat/rag-eval bench test --continue-on-failure
pnpm --filter @ai-chat/rag-eval exec tsx src/capture-traces.ts
$env:RAG_EVAL_JUDGE_VARIANT='agentic-fixed'
evals/rag/.venv/Scripts/python.exe evals/rag/score.py test
pnpm --filter @ai-chat/rag-eval exec tsx src/run-agentic-cases.ts
pnpm --filter @ai-chat/rag-eval exec tsx src/compare-report.ts --publish
```

先完成主测试再评分和专项，不并行压测生成与评委。报告脚本使用 `traditional/` 和指定的 `agentic-fixed/`，发布到 `reports/agentic-v1/agentic-fixed/`，不把旧版七次失败掺入新版本。
