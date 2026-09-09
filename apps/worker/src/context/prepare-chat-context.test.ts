import type {
  ClaimedGenerationExecution,
  ConversationSummaryRecord,
  SaveConversationSummaryInput,
} from "@ai-chat/db";
import { describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { buildChatModelRequest } from "../generation/chat-context-builder";
import { createChatContextPreparer } from "./prepare-chat-context";
import { projectHistory, summaryHistoryText } from "./history-projection";
import {
  countModelMessages,
  countRequestOverhead,
  countTextTokens,
  type ContextPolicy,
} from "./token-budget";
import type { SummarizeHistoryInput } from "./history-summarizer";
import {
  countStoredMessage,
  MESSAGE_TOKEN_VERSION,
} from "@ai-chat/model-context";

const policy: ContextPolicy = {
  triggerTokens: 5000,
  targetTokens: 3000,
  summaryTokens: 500,
  maxInputTokens: 12000,
  maxOutputTokens: 1000,
  summaryBatchTokens: 10000,
};
const signal = () => new AbortController().signal;
function execution(turnCount = 8): ClaimedGenerationExecution {
  return {
    id: "generation",
    conversationId: "conversation",
    userMessageId: `user-${turnCount - 1}`,
    ownerId: "owner",
    mode: "chat",
    reasoningEffort: "medium",
    tools: { webSearch: false, mcpToolIds: [] },
    summary: null,
    attachments: [],
    messages: Array.from({ length: turnCount }, (_, index) => [
      {
        id: `user-${index}`,
        sequence: index * 2,
        role: "user" as const,
        parts: [
          {
            type: "text" as const,
            text:
              index === turnCount - 1
                ? "current question"
                : `turn-${index} ` + "memory evidence ".repeat(340),
          },
        ],
      },
      ...(index === turnCount - 1
        ? []
        : [
            {
              id: `assistant-${index}`,
              sequence: index * 2 + 1,
              role: "assistant" as const,
              parts: [
                {
                  id: `answer-${index}`,
                  type: "text" as const,
                  text: `answer-${index}`,
                },
              ],
            },
          ]),
    ]).flat(),
  };
}
function setup(override: Partial<ContextPolicy> = {}) {
  const summarize = vi.fn(async (input: SummarizeHistoryInput) => {
    input.signal.throwIfAborted();
    return "用户正在研究项目；已确认的决定需要保留，其他建议尚未执行。";
  });
  const save = vi.fn(
    async ({
      expectedVersion,
      ...input
    }: SaveConversationSummaryInput): Promise<ConversationSummaryRecord> => ({
      ...input,
      version: expectedVersion + 1,
      updatedAt: new Date(),
    }),
  );
  return {
    summarize,
    save,
    prepare: createChatContextPreparer({
      summarizer: { modelId: "fake-sol", summarize },
      save,
      saveCounts: vi.fn(async () => {}),
      policy: { ...policy, ...override },
    }),
  };
}

describe("完整轮次的历史压缩（离线假模型）", () => {
  it("200k 触发，60k 总输入目标，不是模型窗口的 30%", async () => {
    const { CHAT_CONTEXT_POLICY } = await import("./token-budget");
    expect(CHAT_CONTEXT_POLICY.targetTokens).toBe(60000);
    expect(
      CHAT_CONTEXT_POLICY.targetTokens / CHAT_CONTEXT_POLICY.triggerTokens,
    ).toBe(0.3);
  });

  it("命中落库计数时只累加，不重新编码旧正文", async () => {
    const input = execution(2);
    for (const message of input.messages)
      message.contextTokenCount = countStoredMessage(message);
    const first = input.messages[0]!;
    // 正常消息是不可变的；用 getter 哨兵证明缓存命中路径没有读取 text。
    Object.defineProperty(first.parts[0], "text", {
      get() {
        throw new Error("should not encode cached text");
      },
    });
    const { prepare, summarize } = setup();
    const result = await prepare({ execution: input, signal: signal() });
    expect(result.status).toBe("unchanged");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("版本变化按需刷新，保持原始消息不变；附件按独立缓存计数", async () => {
    const input = execution(2);
    input.messages[0]!.contextTokenCount = { version: "old", textTokens: 1 };
    const first = input.messages[0]!;
    if (first.role !== "user") throw new Error("expected user");
    first.parts.push({ type: "attachment", attachmentId: "file" });
    const saveCounts = vi.fn(async () => {});
    const prepare = createChatContextPreparer({
      summarizer: { modelId: "fake", summarize: vi.fn() },
      policy,
      saveCounts,
      countAttachments: async () => new Map([["file", 1200]]),
    });
    const result = await prepare({ execution: input, signal: signal() });
    expect(result.inputTokens).toBeGreaterThan(2200);
    expect(saveCounts).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "owner",
        conversationId: "conversation",
        counts: expect.arrayContaining([
          expect.objectContaining({
            id: "user-0",
            count: expect.objectContaining({ version: MESSAGE_TOKEN_VERSION }),
          }),
        ]),
      }),
    );
  });

  it("完整摘要超过 8k 目标但仍减少输入时可保存，不因软目标直接失败", async () => {
    const { prepare, summarize, save } = setup();
    summarize.mockResolvedValue("summary ".repeat(550));
    const result = await prepare({ execution: execution(), signal: signal() });
    expect(result.status).toBe("compressed");
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]![0].tokenCount).toBeGreaterThan(
      policy.summaryTokens,
    );
  });

  it("摘要反而变长则保留原历史，不保存无效压缩", async () => {
    const { prepare, summarize, save } = setup();
    summarize.mockResolvedValue("summary ".repeat(10000));
    const result = await prepare({ execution: execution(), signal: signal() });
    expect(result.status).toBe("summary-failed");
    expect(save).not.toHaveBeenCalled();
  });
  it("大历史轮次独占一批，不因超过常规批次目标而永久卡住会话", async () => {
    const { prepare, summarize, save } = setup({ summaryBatchTokens: 3000 });
    const input = execution(4);
    input.messages[0]!.parts = [
      { type: "text", text: "large history evidence ".repeat(1500) },
    ];
    const result = await prepare({ execution: input, signal: signal() });
    expect(result.status).toBe("compressed");
    expect(summarize.mock.calls[0]![0].history).toHaveLength(1);
    expect(summarize.mock.calls[0]![0].history[0]).toContain(
      "large history evidence",
    );
    expect(
      result.execution.messages.some((message) => message.id === "user-2"),
    ).toBe(true);
    expect(save).toHaveBeenCalledOnce();
  });
  it("短会话不调用摘要，不保存摘要", async () => {
    const { prepare, summarize, save } = setup();
    const input = execution(2);
    const result = await prepare({ execution: input, signal: signal() });
    expect(result.execution).toBe(input);
    expect(result.status).toBe("unchanged");
    expect(summarize).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("按完整轮次压缩，只整理被覆盖历史，原消息、近期轮次和当前问题均不改动", async () => {
    const { prepare, summarize, save } = setup();
    const input = execution();
    const original = structuredClone(input);
    const result = await prepare({ execution: input, signal: signal() });
    expect(result.status).toBe("compressed");
    expect(result.inputTokens).toBeLessThanOrEqual(policy.targetTokens);
    expect(result.targetReached).toBe(true);
    expect(result.execution.messages.at(-1)).toEqual(input.messages.at(-1));
    expect(
      result.execution.messages.some((message) => message.id === "user-6"),
    ).toBe(true);
    expect(result.execution.messages[0]?.role).toBe("user");
    const cutoff = save.mock.calls[0]![0];
    expect(cutoff.coveredThroughSequence).toBe(
      result.execution.messages[0]!.sequence - 1,
    );
    expect(cutoff.coveredThroughMessageId).toBe(
      input.messages[cutoff.coveredThroughSequence]!.id,
    );
    const summarizerInput = JSON.stringify(summarize.mock.calls);
    expect(summarizerInput).not.toContain("current question");
    for (const message of result.execution.messages)
      expect(summarizerInput).not.toContain(
        message.id.replace("user-", "turn-"),
      );
    expect(input).toEqual(original);
  });

  it("已有摘要参与预算，并与新覆盖历史滚动替换而非重复追加", async () => {
    const { prepare, summarize, save } = setup();
    const input = execution();
    input.messages = input.messages.map((message) => ({
      ...message,
      sequence: message.sequence + 10,
    }));
    input.summary = {
      conversationId: input.conversationId,
      content: "previous decisions",
      coveredThroughSequence: 9,
      coveredThroughMessageId: "old-boundary",
      version: 3,
      modelId: "fake",
      tokenizer: "old",
      promptVersion: 1,
      tokenCount: 3,
      generationId: "old-generation",
      updatedAt: new Date(),
    };
    const result = await prepare({ execution: input, signal: signal() });
    expect(summarize.mock.calls[0]![0].previousSummary).toBe(
      "previous decisions",
    );
    expect(save.mock.calls[0]![0].expectedVersion).toBe(3);
    expect(result.execution.summary?.version).toBe(4);
    expect(result.summary).toBe(await summarize.mock.results[0]!.value);
  });

  it("非常长的历史分批摘要，中间结果不落库，最后一次原子推进边界", async () => {
    const { prepare, summarize, save } = setup({ summaryBatchTokens: 3000 });
    const result = await prepare({ execution: execution(), signal: signal() });
    expect(result.status).toBe("compressed");
    expect(summarize.mock.calls.length).toBeGreaterThan(1);
    expect(summarize.mock.calls[1]![0].previousSummary).toBe(
      await summarize.mock.results[0]!.value,
    );
    expect(save).toHaveBeenCalledTimes(1);
  });

  it.each(["empty", "error"])(
    "摘要 %s：安全预算内退回原上下文，不推进边界",
    async (failure) => {
      const { prepare, summarize, save } = setup();
      summarize.mockImplementation(async () => {
        if (failure === "error") throw new Error("provider failed");
        return failure === "empty" ? " " : "over limit ".repeat(600);
      });
      const input = execution();
      const result = await prepare({ execution: input, signal: signal() });
      expect(result.status).toBe("summary-failed");
      expect(result.execution).toBe(input);
      expect(save).not.toHaveBeenCalled();
    },
  );

  it("摘要失败且原输入超过安全预算，明确失败，不截断或调用回答模型", async () => {
    const { prepare, summarize, save } = setup();
    summarize.mockRejectedValue(new Error("provider failed"));
    await expect(
      prepare({ execution: execution(20), signal: signal() }),
    ).rejects.toThrow("provider failed");
    expect(save).not.toHaveBeenCalled();
  });

  it("摘要途中取消，即使模型返回文字也不保存、不回退继续生成", async () => {
    const { prepare, summarize, save } = setup();
    const controller = new AbortController();
    summarize.mockImplementation(async () => {
      controller.abort(new Error("user stopped"));
      return "partial summary";
    });
    await expect(
      prepare({ execution: execution(), signal: controller.signal }),
    ).rejects.toThrow("user stopped");
    expect(save).not.toHaveBeenCalled();
  });

  it("保存边界冲突不能被当作模型失败而悄悄回退", async () => {
    const { prepare, save } = setup();
    save.mockRejectedValue(new Error("SUMMARY_SAVE_CONFLICT"));
    await expect(
      prepare({ execution: execution(), signal: signal() }),
    ).rejects.toThrow("SUMMARY_SAVE_CONFLICT");
  });

  it("近期轮次过大时可以超目标，但不牺牲当前问题；超安全预算则报错", async () => {
    const { prepare, summarize } = setup();
    const input = execution(2);
    input.messages.at(-1)!.parts = [
      { type: "text", text: "large current ".repeat(2500) },
    ];
    const result = await prepare({ execution: input, signal: signal() });
    expect(result.targetReached).toBe(false);
    expect(result.execution).toBe(input);
    expect(summarize).not.toHaveBeenCalled();
    input.messages.at(-1)!.parts = [
      { type: "text", text: "large current ".repeat(8000) },
    ];
    await expect(
      prepare({ execution: input, signal: signal() }),
    ).rejects.toThrow("CHAT_CONTEXT_TOO_LARGE");
  });

  it("工具定义纳入输入预算，execute 函数不参与计数且不会被执行", async () => {
    const execute = vi.fn(async () => "done");
    const tools = {
      lookup: tool({
        description: "tool description ".repeat(7500),
        inputSchema: z.object({ query: z.string() }),
        execute,
      }),
    };
    expect(await countRequestOverhead("system", tools)).toBeGreaterThan(12000);
    const { prepare } = setup();
    await expect(
      prepare({ execution: execution(2), tools, signal: signal() }),
    ).rejects.toThrow("CHAT_CONTEXT_TOO_LARGE");
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("模型历史投影与附件预算", () => {
  it("摘要与回放都移除旧 RAG 原文及思考；其他缺失的工具结果保持未知", () => {
    const input = execution(2);
    input.messages[1] = {
      id: "assistant-0",
      role: "assistant",
      sequence: 1,
      parts: [
        { id: "r", type: "reasoning", text: "tentative-thought" },
        {
          id: "k",
          type: "tool-call",
          toolCallId: "k",
          toolName: "search_knowledge",
          input: { query: "old-query" },
        },
        {
          id: "kr",
          type: "tool-result",
          toolCallId: "k",
          output: { text: "raw-private-document" },
          isError: false,
        },
        {
          id: "m",
          type: "tool-call",
          toolCallId: "m",
          toolName: "mail.send",
          input: { to: "test@example.com" },
        },
        { id: "a", type: "text", text: "confirmed answer" },
      ],
    };
    const text = summaryHistoryText(projectHistory(input, input.messages));
    expect(text).not.toContain("tentative-thought");
    expect(text).not.toContain("raw-private-document");
    expect(text).not.toContain("old-query");
    expect(text).toContain("TOOL_RESULT_UNAVAILABLE");
    expect(text).toContain("confirmed answer");
  });

  it("摘要仅使用附件 ID/名称，不包含临时 URL；计数为附件内容预留预算", async () => {
    const input = execution(2);
    input.attachments = [
      {
        id: "file",
        originalName: "report.pdf",
        objectKey: "private/object",
        mediaType: "application/pdf",
        status: "ready",
      },
    ];
    const first = input.messages[0]!;
    if (first.role !== "user") throw new Error("expected user");
    first.parts.push({ type: "attachment", attachmentId: "file" });
    const projected = projectHistory(input, input.messages);
    expect(countModelMessages(projected, () => 3200)).toBeGreaterThan(3200);
    expect(() => countModelMessages(projected)).toThrow(
      "ATTACHMENT_TOKEN_COUNT_MISSING",
    );
    const text = summaryHistoryText(projected);
    expect(text).toContain("report.pdf");
    expect(text).toContain("未读取附件内容");
    expect(text).not.toContain("private/object");
    const createDownloadUrl = vi.fn(async () => "https://signed.example/file");
    await buildChatModelRequest(
      { ...input, messages: [input.messages.at(-1)!] },
      { createDownloadUrl },
    );
    expect(createDownloadUrl).not.toHaveBeenCalled();
  });

  it("使用 tokenizer 处理中文、代码和特殊标记，不按字符除四", () => {
    expect(countTextTokens("hello world")).toBe(2);
    expect(countTextTokens("你好，知识库")).toBeGreaterThan(2);
    expect(() =>
      countTextTokens("<|endoftext|> const x = 1; 🧠"),
    ).not.toThrow();
  });
});
