import {
  saveConversationSummary,
  saveMessageTokenCounts,
  type ClaimedGenerationExecution,
  type ConversationSummaryRecord,
} from "@ai-chat/db";
import type { ToolSet } from "ai";
import {
  countStoredMessage,
  MESSAGE_TOKEN_VERSION,
  type MessageTokenCount,
} from "@ai-chat/model-context";
import type { AttachmentTokenCounter } from "./attachment-token-counts";
import {
  groupHistoryTurns,
  projectHistory,
  summaryHistoryText,
  summaryMessage,
} from "./history-projection";
import {
  SUMMARY_INSTRUCTIONS,
  SUMMARY_PROMPT_VERSION,
  summaryPrompt,
  type HistorySummarizer,
} from "./history-summarizer";
import {
  assertInputBudget,
  CHAT_CONTEXT_POLICY,
  countModelMessages,
  countRequestOverhead,
  countTextTokens,
  TOKENIZER_ID,
  type ContextPolicy,
} from "./token-budget";

export type PreparedChatContext = {
  execution: ClaimedGenerationExecution;
  summary: string | null;
  status: "unchanged" | "compressed" | "summary-failed";
  inputTokens: number;
  targetReached: boolean;
};
export type ChatContextPreparer = (input: {
  execution: ClaimedGenerationExecution;
  instructions?: string;
  tools?: ToolSet;
  signal: AbortSignal;
}) => Promise<PreparedChatContext>;

export function createChatContextPreparer(dependencies: {
  summarizer: HistorySummarizer;
  save?: typeof saveConversationSummary;
  saveCounts?: typeof saveMessageTokenCounts;
  countAttachments?: AttachmentTokenCounter;
  policy?: ContextPolicy;
}): ChatContextPreparer {
  const policy = dependencies.policy ?? CHAT_CONTEXT_POLICY;
  if (
    Object.values(policy).some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    ) ||
    policy.summaryTokens >= policy.targetTokens ||
    policy.targetTokens >= policy.triggerTokens ||
    policy.triggerTokens >= policy.maxInputTokens ||
    policy.summaryBatchTokens >= policy.maxInputTokens
  ) {
    throw new Error("CHAT_CONTEXT_POLICY_INVALID");
  }
  const save = dependencies.save ?? saveConversationSummary;

  return async ({ execution, instructions, tools, signal }) => {
    signal.throwIfAborted();
    if (
      execution.mode !== "chat" ||
      execution.messages.at(-1)?.id !== execution.userMessageId
    ) {
      throw new Error("CHAT_HISTORY_INVALID: 当前问题必须是最后一条消息");
    }
    const turns = groupHistoryTurns(execution.messages);
    const overhead = await countRequestOverhead(instructions, tools);
    const attachmentCounts = dependencies.countAttachments
      ? await dependencies.countAttachments(execution, signal)
      : new Map<string, number>();
    signal.throwIfAborted();
    const refreshed: { id: string; count: MessageTokenCount }[] = [];
    const costs = turns.map((turn) =>
      turn.reduce((sum, message) => {
        let count = message.contextTokenCount;
        if (count?.version !== MESSAGE_TOKEN_VERSION) {
          count = countStoredMessage(message);
          refreshed.push({ id: message.id, count });
        }
        const files = message.parts.reduce((tokens, part) => {
          if (part.type !== "attachment") return tokens;
          const fileTokens = attachmentCounts.get(part.attachmentId);
          if (fileTokens === undefined)
            throw new Error("ATTACHMENT_TOKEN_COUNT_MISSING");
          return tokens + fileTokens;
        }, 0);
        return sum + count.textTokens + files;
      }, 0),
    );
    if (refreshed.length) {
      try {
        await (dependencies.saveCounts ?? saveMessageTokenCounts)({
          ownerId: execution.ownerId,
          conversationId: execution.conversationId,
          counts: refreshed,
        });
      } catch {
        console.warn("Message token cache was not saved", {
          conversationId: execution.conversationId,
        });
      }
    }
    signal.throwIfAborted();
    const previousSummary = execution.summary?.content ?? null;
    const summaryCost = (content: string | null) =>
      content ? countModelMessages([summaryMessage(content)]) : 0;
    const originalTokens =
      overhead +
      summaryCost(previousSummary) +
      costs.reduce((sum, cost) => sum + cost, 0);

    function unchanged(
      status: "unchanged" | "summary-failed",
    ): PreparedChatContext {
      assertInputBudget(originalTokens, policy.maxInputTokens);
      return {
        execution,
        summary: previousSummary,
        status,
        inputTokens: originalTokens,
        targetReached: originalTokens <= policy.targetTokens,
      };
    }
    if (originalTokens < policy.triggerTokens) return unchanged("unchanged");

    // token 决定何时压缩，完整 user 轮次决定切在哪里。最近一轮与当前问题固定保留。
    let coveredTurns = 0;
    let remainingTokens = costs.reduce((sum, cost) => sum + cost, 0);
    const reservedSummary = policy.summaryTokens + summaryCost(" ");
    while (
      coveredTurns < turns.length - 2 &&
      overhead + reservedSummary + remainingTokens > policy.targetTokens
    ) {
      remainingTokens -= costs[coveredTurns]!;
      coveredTurns++;
    }
    if (coveredTurns === 0) return unchanged("unchanged");

    let content = previousSummary;
    try {
      // 首次导入很长的会话也分批整理；每批仍以完整轮次为单位，不截断工具调用。
      // 只有真正需要摘要时才展开旧消息投影，日常请求直接累加落库计数。
      const pending = turns
        .slice(0, coveredTurns)
        .map((turn) => summaryHistoryText(projectHistory(execution, turn)));
      const pendingCosts = pending.map(
        (text) => countTextTokens(JSON.stringify(text)) + 4,
      );
      let offset = 0;
      const promptOverhead = countTextTokens(SUMMARY_INSTRUCTIONS) + 1024;
      while (offset < pending.length) {
        signal.throwIfAborted();
        const history: string[] = [];
        let batchTokens =
          promptOverhead +
          countTextTokens(
            summaryPrompt({ previousSummary: content, history: [] }),
          );
        while (offset < pending.length) {
          if (batchTokens + pendingCosts[offset]! > policy.summaryBatchTokens)
            break;
          batchTokens += pendingCosts[offset]!;
          history.push(pending[offset++]!);
        }
        // 单个完整轮次较大时单独处理，允许超过常规批次目标，但仍受安全预算限制。
        // 否则一个历史大工具结果会让会话永远无法继续压缩。
        const batchLimit = history.length
          ? policy.summaryBatchTokens
          : policy.maxInputTokens;
        if (!history.length) history.push(pending[offset++]!);
        // 逐轮累计避免反复编码整个候选批次，调用前再验证实际 prompt。
        assertInputBudget(
          promptOverhead +
            countTextTokens(
              summaryPrompt({ previousSummary: content, history }),
            ),
          batchLimit,
        );
        content = await dependencies.summarizer.summarize({
          previousSummary: content,
          history,
          targetTokens: policy.summaryTokens,
          signal,
        });
        signal.throwIfAborted();
        if (!content.trim()) throw new Error("HISTORY_SUMMARY_INVALID");
      }
    } catch (error) {
      signal.throwIfAborted();
      // 摘要失败不保存半成品。原请求仍在安全预算内才继续，否则沿现有失败流程退出。
      if (originalTokens > policy.maxInputTokens) throw error;
      return unchanged("summary-failed");
    }

    signal.throwIfAborted();
    const inputTokens = overhead + remainingTokens + summaryCost(content);
    // 8k 是目标，不因轻微超出丢弃完整摘要；但压缩必须真正减少总输入。
    if (inputTokens >= originalTokens || inputTokens > policy.maxInputTokens)
      return unchanged("summary-failed");
    const boundary = turns[coveredTurns - 1]!.at(-1)!;
    const saved: ConversationSummaryRecord = await save({
      conversationId: execution.conversationId,
      generationId: execution.id,
      expectedVersion: execution.summary?.version ?? 0,
      content: content!,
      coveredThroughSequence: boundary.sequence,
      coveredThroughMessageId: boundary.id,
      modelId: dependencies.summarizer.modelId,
      tokenizer: TOKENIZER_ID,
      promptVersion: SUMMARY_PROMPT_VERSION,
      tokenCount: countTextTokens(content!),
    });
    signal.throwIfAborted();
    return {
      execution: {
        ...execution,
        summary: saved,
        messages: turns.slice(coveredTurns).flat(),
      },
      summary: saved.content,
      status: "compressed",
      inputTokens,
      // 60k 是目标而非硬切线；若近期轮次本身较大，可超目标但不能超安全预算。
      targetReached: inputTokens <= policy.targetTokens,
    };
  };
}
