# 传统 RAG 端到端评测与小规模参数对比

本目录已发布的结果对应传统版 Git 提交 `7134eb0`。业务现已转为 Agentic；复现传统成绩请在该提交的独立 worktree 中运行下述命令。当前分支启动的 host 会加载当前业务代码，不能将新运行结果直接标成传统基线；Agentic 的工具轨迹、预算与评分对比需要另开一轮实验。

评测属于 `evals/rag`，不把 compare/evaluate 加回业务数据库。未自动修改业务的分块、检索参数或提示词。需要先阅读实验口径，不能把这里的结果当作官方榜单或所有知识库场景的结论。

## 数据与隔离

- 使用 [CMRC 2018](https://github.com/ymcui/cmrc2018) 官方 dev，固定提交 `c0eb1b6ba219847457e6af3180da722bbeb656af` 和源文件 SHA256，许可 CC-BY-SA-4.0。
- 全部 848 段原文均导入候选库，约 43 万字符；不是只导入抽中题目的答案文档。导出 TXT，不掺入题目和答案。当前业务 parser 的 800/100 切出 948 块；没有 PDF/OCR 测试。
- 原始 3,219 题中，176 题存在至少一个无效答案位置（如 `answer_start=-1` 或答案文本与原文不符），保守排除整题并记录名单；其余 3,043 题参与确定性抽样。严格筛选可能带来样本偏差，不能称为完整 dev 分数。
- 固定种子哈希抽样，5 题试跑、20 题调参、50 题测试，不共享源文章，同一原文去重。新增调参题没有改变原先固定的试跑/测试题。
- 答案位置从上游码点偏移转换为 JS UTF-16 偏移。业务 chunk 仍以字符而非 token 切分。已知答案区间不等于穷尽相关性标注。
- 网站评测实例为 `localhost:3301`，独立 `ai_chat_eval_cmrc2018`、Redis DB 14 和 `.next-rag-eval`。不重启、不改写原网站使用的数据库、队列和环境文件。
- `bench upload` 走实际认证、创建知识库、获取预签名、直接 PUT R2、complete、Worker 入库流程。`bench pilot/test` 走真实 Generation API 和 SSE，再读数据库投影的会话，检查最终正文与 SSE 正文一致。不是浏览器 UI 测试。

## 参数实验

预注册 24 组组合：

| 参数 | 对照值 |
| --- | --- |
| size / overlap | 600/80、800/0、800/100、1000/150 |
| 每路召回 | 10、20、30 |
| 精排保留 | 3、6 |

保留全量 RRF 并集，最多 60 条；使用相同业务 SQL、HNSW 查询配置、中文 BM25、RRF(k=60)、精排模型。每个召回档位独立精排，精排返回 6 条并取前 3/6，避免重复收费。Query embedding 和完全相同文本的 chunk embedding 缓存复用。

不同分块方案放在不同 `ai_chat_eval_cmrc_*` 数据库，避免多个版本的重复语料污染共享 BM25 统计。参数实验通过业务 `chunkPages`、repository publish 和查询模块运行，不重复执行 R2 上传；默认 800/100 直接读取完整 HTTP 入库生成的库。

选择规则：先看调参题已知答案区间 hit，再看 MRR；相同则优先保留默认配置，其次比较最终上下文字节数。选择固定后，仅对默认与候选在未参与调参的 50 题上验证。该网格是有限范围探索：不能拆开证明每个 size/overlap 单独最优，也没有测试大于 6 的最终引用数（目前业务契约上限为 6）。

参数实验先衡量证据召回与上下文体积，不代表每个配置都跑了最终回答评分。最终回答质量由默认完整 RAG 的独立测试给出；不因为某个检索分数略高就替换业务默认值。

## 评分

- 使用 `Ragas==0.4.3` 的 `Faithfulness` 和 `AnswerAccuracy`，不是自造同名评分公式。后者使用同一模型的两种判断提示，并非两个独立模型。保留逐题 judge 输入和结构化判断，供人工审阅。
- Judge 使用一个小型 Responses 流式协议适配器，沿用 Ragas 原始提示、输出 schema 和计分；没有重写评分算法。Chat Completions 试跑的超时费用保留在账本中。
- 回答模型沿用渠道 `gpt-5.6-sol / medium`，judge 使用渠道 `gpt-6-astra / low`。模型名称不证明中转上游模型身份。没有改写业务 RAG prompt；仅在评测费用入口添加 8,192 输出 token 上限。
- Ragas 使用原始英文评分提示处理中文内容；AnswerAccuracy 固定采用第一份人工短答案，保留其他答案但不事后挑最高分。不能把语义评分当成人工真值。
- 辅助报告 known-answer evidence hit@6、MRR@6、引用编号合法率、首正文和总耗时。引用编号合法不等于指定引用支持对应句子；Faithfulness 检查的是全部检索上下文对回答的支持。
- 未完成全部指定题目或存在未处理失败时，正式报告拒绝给平均分。试跑和测试文件分开，未知/失败用量不能记为零。
- 百科短文且全部为可回答问题，不覆盖长文档、跨页表格、OCR、拒答、多轮指代、恶意文档等。开发实例与渠道延迟不是生产吞吐量结论。

### 本轮采用的离线 Codex 评委

用户确认后，因渠道 Astra 连续过载失败，正式评分改为明确指定 `gpt-6-astra`、`fork_turns=none` 的 Codex 子 agent。之前 API 试跑的费用和两条 Sol 评分保留，**不混入正式分数**。

`offline_judge.py` 导出 Ragas 原始提示及 schema，分别执行事实拆分、准确性判断、NLI 证据判断。不同阶段使用新上下文，事实拆分不接触参考答案，NLI 不接触参考答案和准确性分数；只提供评分所需材料，不提供生成模型、检索配置、已有成绩。子 agent 无需浏览或调用外部工具来寻找答案。共享工作区不是权限隔离，这里通过任务范围限制读取。

批内多个样本共享上下文，所以这不是标准逐请求 API 隔离的完全等价执行。准确性两种判断也不是两个独立模型。所有请求、schema、答案、结果均以哈希匹配，回放时直接调用 Ragas 原 `Faithfulness`、`AnswerAccuracy`，检查四步齐全、离散分值有效、NLI 逐条对应；缺失判断不接受库的单评委回退。未指定目标分数，未根据成绩修改 rubric。

```powershell
evals/rag/.venv/Scripts/python.exe evals/rag/offline_judge.py export pilot --phase statements
evals/rag/.venv/Scripts/python.exe evals/rag/offline_judge.py export pilot --phase accuracy
# 将每份 *.requests.json 单独交给新上下文评委，保存对应 *.outputs.json。
# statements 完成后才能导出 NLI。
evals/rag/.venv/Scripts/python.exe evals/rag/offline_judge.py export pilot --phase nli
evals/rag/.venv/Scripts/python.exe evals/rag/offline_judge.py validate pilot
evals/rag/.venv/Scripts/python.exe evals/rag/offline_judge.py replay pilot
# test 同理；--available 可先导出已成功回答，最终 replay 仍要求完整 50 题。
pnpm --filter @ai-chat/rag-eval report --offline-judge --publish
```

这是原 Ragas 指标的自定义离线执行器，不是随意让 agent 给一个总分，也不是官方认证评测。Codex 额度独立消耗，不纳入中转 API 的人民币账本；报告需要分别披露。

## 预算

本轮累计最多 **¥20**，包含入库、调参、最终回答和评分。预算入口仅监听本机随机端口，需要随机令牌，仅转发白名单模型/路径；它不是业务网关。SDK、Instructor 和评分器不做自动重试。

`usage.jsonl` 持久化预留与结算，重启不刷新额度；进程中断、请求失败或缺少 usage 保留预留。调用前使用 UTF-8 字节数及包装余量保守估算输入，输出有显式上限。供应商违反上限或错误上报 usage 无法由客户端绝对保证，检测到超预留会停止后续调用。

单价依据 2026-09-08 用户提供的渠道截图（标准倍率 0.12、专业 0.15）及百炼文档。Sol 专业正常输入/输出为 ¥0.60/¥3.00 每百万 token；预算输入按更高的缓存写入档 ¥0.75 计。Astra 输入按 ¥1.875、输出 ¥7.50。百炼 embedding/rerank 按 ¥0.50/百万输入 token。不假设缓存折扣或免费额度。这是费用估计，不是供应商最终账单；没有查询/修改账户充值或限额。

## 操作（PowerShell，仓库根目录）

```powershell
pnpm install
pnpm --filter @ai-chat/rag-eval data:prepare
python -m venv evals/rag/.venv
evals/rag/.venv/Scripts/python.exe -m pip install -r evals/rag/requirements.txt

# 独立终端保持运行；读取已有 Worker/Web 的被忽略环境文件。
pnpm --filter @ai-chat/rag-eval host

# 另一个终端：完整上传和入库。
pnpm --filter @ai-chat/rag-eval bench upload
pnpm --filter @ai-chat/rag-eval bench pilot
evals/rag/.venv/Scripts/python.exe evals/rag/score.py pilot

# 20 道调参题 -> 固定候选 -> 50 道测试题。
pnpm --filter @ai-chat/rag-eval tune tune
pnpm --filter @ai-chat/rag-eval tune test
pnpm --filter @ai-chat/rag-eval bench test
evals/rag/.venv/Scripts/python.exe evals/rag/score.py test
pnpm --filter @ai-chat/rag-eval report --publish
```

没有自动删除知识库、评测数据库或对象存储文件。Host 中 Ctrl+C 只关闭它启动的评测子进程；正常业务进程不受影响。多个 runner/scorer/tuner 各有锁，账本只有 host 写入。异常退出遗留锁时先确认原进程已停止，再手动删除对应锁。失败上传/生成先检查，不会静默反复花钱重试。完整数据和运行凭证仅保存在 Git 忽略的 `artifacts/`；不要分享 `runtime.json`、`state.json` 或日志。发布报告只复制不含凭证的结果和配置。

渠道偶发失败时，`bench test --continue-on-failure` 会保留失败并继续下一题；检查原因后可显式运行 `bench test --retry-failed --continue-on-failure`。原始失败不删除，报告区分首次成功率与重试后回答的条件质量，不能把重试后的结果称为一次完成率。
