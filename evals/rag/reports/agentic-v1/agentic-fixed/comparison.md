# 同渠道传统 RAG 与 Agentic RAG 对比

50 道固定 CMRC 回归题、完整 848 篇候选原文；不是官方榜单。传统基线 7134eb0，Agentic 基线 9e55d20c71fb6b1ee8569de7a401b075dfd93753。两边 Sol / medium、同一本地 Proxy、每次模型输出上限 8192 token。Astra / low 用 Ragas 0.4.3 原始提示与算法评分。

| 指标 | 传统 | Agentic |
| --- | ---: | ---: |
| firstAttemptCompleted | 50 | 48 |
| attempts | 50 | 52 |
| answerAccuracy | 0.885 | 0.86 |
| faithfulness | 0.9815909090909091 | 0.8899917925212041 |
| evidenceHit | 1 | 1 |
| sourcesMean | 6 | 6.48 |
| knowledgeCallsMean | 0 | 1.22 |
| modelCalls | 50 | 111 |
| inputTokens | 132022 | 231967 |
| outputTokens | 3665 | 10034 |
| unknownUsage | 0 | 2 |
| firstTextP50Ms | 3434.5432000000146 | 7814.6417000000365 |
| totalP50Ms | 5078.9064 | 9931.463400000008 |
| totalP95Ms | 11276.303899999999 | 36831.8781 |

## 配对差异

Agentic 减传统：AnswerAccuracy -0.025，配对 bootstrap 95% CI [-0.07,0.015]；Faithfulness -0.0915991165697048，95% CI [-0.14208263305322127,-0.04705009696186168]。正确性评分提高/持平/下降：3/42/5。

## 口径

AnswerAccuracy 不是答对比例；Faithfulness 衡量累计检索资料对整段回答的支持，不等于每个引用都正确。evidenceHit 仅检查已知答案区间是否出现在累计来源中；Agentic 可多次检索，不能把此数当单次 Recall@6 或 MRR@6。工具调用次数、全部模型调用的 token 和延迟同时报告；订阅 token 无人民币折算，缺失 usage 不当作零。

旧测试集已被检查，因此这是固定回归比较，不是全新盲测集。两种方案分批执行，共享渠道负载/缓存与模型随机性影响延迟；单次生成、50 题不能证明普遍提升。额外专项为手工构造回归案例，另行报告。原始问题、回答、逐题分数见 comparison.json。

付费检索预算计入金额 ¥1.990665 / ¥10，未结算请求 0；这是按用量保守估计，不是供应商账单。

## 修复版记录

本报告采用 agentic-fixed 的完整独立重跑，不复用旧版成功回答。版本标识：

```json
{
  "baseCommit": "9e55d20c71fb6b1ee8569de7a401b075dfd93753",
  "patchSha256": "81684d1041c7d021dcb04753776c9775050032d845dbbccc11aa877428be747c",
  "change": "SSE sources reuse message snapshot schema (18 max)",
  "previousRun": "agentic",
  "rerun": "all 5 pilot and 50 test questions; no previous answers reused"
}
```

旧版 43/50 的完成率与七次来源契约错误见上级目录 current-version-diagnosis.md，不因修复版结果而删除。检索费用累计包含旧版、试跑和修复版，不是本表 50 题单独费用。

质量与时延取每题最后一次成功回答；首次完成数保留原始失败，attempts 含人工确认后补跑。表中 modelCalls、inputTokens、outputTokens 和 unknownUsage 仅统计这 50 题所有生成尝试的 Sol 请求，不含 Astra 评分请求；评分用量另记于订阅用量日志。unknownUsage 非零时 token 只是已知部分，不能视作完整成本。知识库调用均值对应被评分的最后一次成功回答。
