import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimedGenerationExecution } from "@ai-chat/db";
import {
  cancelGenerationExecution,
  completeGenerationExecution,
  failGenerationExecution,
  isGenerationCancellationRequested,
} from "@ai-chat/db";
import type { GenerationEventDto, KnowledgeSourceDto } from "@ai-chat/contracts";
import type { ChatModelRequest, ChatModelStreamPart } from "../llm/chat-model";
import {
  executeChatGeneration,
  type ExecuteChatGenerationDependencies,
} from "./execute-chat-generation";

vi.mock("@ai-chat/db", () => ({
  cancelGenerationExecution: vi.fn(),
  completeGenerationExecution: vi.fn(),
  failGenerationExecution: vi.fn(),
  isGenerationCancellationRequested: vi.fn(),
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isGenerationCancellationRequested).mockResolvedValue(false);
  vi.mocked(cancelGenerationExecution).mockResolvedValue(true);
  vi.mocked(completeGenerationExecution).mockResolvedValue("assistant");
  vi.mocked(failGenerationExecution).mockResolvedValue(true);
});

const execution: ClaimedGenerationExecution = {
  id: "generation",
  conversationId: "conversation",
  ownerId: "owner",
  userMessageId: "current",
  mode: "chat",
  reasoningEffort: "medium",
  tools: { webSearch: false, mcpToolIds: [] },
  summary: null,
  attachments: [],
  messages: [
    {
      id: "current",
      sequence: 0,
      role: "user",
      parts: [{ type: "text", text: "问题" }],
    },
  ],
};
function setup() {
  const events: GenerationEventDto[] = [];
  let cancel: () => void = () => {};
  const unsubscribe = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const stream = vi.fn(async function* (
    _request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamPart> {
    _request.abortSignal?.throwIfAborted();
    yield { type: "text", partId: "text", delta: "回答" };
    yield { type: "finish", reason: "stop" };
  });
  const prepareContext = vi.fn<
    ExecuteChatGenerationDependencies["prepareContext"]
  >(async ({ execution }) => ({
    execution,
    summary: "历史摘要",
    status: "compressed",
    inputTokens: 2000,
    targetReached: true,
  }));
  const resolve = vi.fn(async () => ({
    instructions: "system",
    tools: undefined,
    toPublicToolName: (name: string) => name,
    activeTools: () => [],
    takeSources: (): KnowledgeSourceDto[] => [],
    close,
  }));
  const dependencies: ExecuteChatGenerationDependencies = {
    chatModel: { stream },
    prepareContext,
    toolResolver: { resolve },
    objectStorage: {
      createDownloadUrl: vi.fn(async () => "https://example.test/file"),
    },
    cancellationSubscriber: {
      subscribe: async (_id, onCancellation) => {
        cancel = onCancellation;
        return unsubscribe;
      },
      close: async () => {},
    },
    eventWriter: {
      append: async (event) => {
        events.push(event);
        return `${events.length}-0`;
      },
    },
  };
  return {
    dependencies,
    stream,
    prepareContext,
    resolve,
    close,
    unsubscribe,
    events,
    cancel: () => cancel(),
  };
}

describe("摘要准备接入 Generation 生命周期", () => {
  it("先取工具定义再准备历史，摘要只给模型、不进入回答 Parts 或 SSE", async () => {
    const context = setup();
    expect(
      await executeChatGeneration(execution, context.dependencies),
    ).toMatchObject({ kind: "completed" });
    expect(context.resolve.mock.invocationCallOrder[0]).toBeLessThan(
      context.prepareContext.mock.invocationCallOrder[0]!,
    );
    expect(context.prepareContext.mock.calls[0]![0].instructions).toBe(
      "system",
    );
    expect(context.stream.mock.calls[0]![0].historySummary).toBe("历史摘要");
    expect(JSON.stringify(context.events)).not.toContain("历史摘要");
    expect(
      JSON.stringify(vi.mocked(completeGenerationExecution).mock.calls),
    ).not.toContain("历史摘要");
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.unsubscribe).toHaveBeenCalledOnce();
  });

  it("摘要阶段收到取消后走 cancelled，绝不启动回答模型，释放订阅与 MCP", async () => {
    const context = setup();
    context.prepareContext.mockImplementation(async ({ signal }) => {
      vi.mocked(isGenerationCancellationRequested).mockResolvedValue(true);
      context.cancel();
      signal.throwIfAborted();
      throw new Error("unreachable");
    });
    expect(
      await executeChatGeneration(execution, context.dependencies),
    ).toEqual({ kind: "cancelled", assistantMessageId: null });
    expect(context.stream).not.toHaveBeenCalled();
    expect(completeGenerationExecution).not.toHaveBeenCalled();
    expect(context.events.at(-1)?.type).toBe("generation.cancelled");
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.unsubscribe).toHaveBeenCalledOnce();
  });

  it("历史无法放进安全预算时走 failed，绝不发送超限请求", async () => {
    const context = setup();
    context.prepareContext.mockRejectedValue(
      new Error("CHAT_CONTEXT_TOO_LARGE"),
    );
    await expect(
      executeChatGeneration(execution, context.dependencies),
    ).rejects.toThrow("CHAT_CONTEXT_TOO_LARGE");
    expect(context.stream).not.toHaveBeenCalled();
    expect(failGenerationExecution).toHaveBeenCalledOnce();
    expect(vi.mocked(failGenerationExecution).mock.calls[0]![0])
      .not.toHaveProperty("partialMessage");
    expect(context.events.at(-1)?.type).toBe("generation.failed");
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("失败回答的持久化", () => {
  it.each(["text", "reasoning"] as const)(
    "哪怕只有一个 %s 字符也保存，并在保存后发布失败终态", async (type) => {
      const context = setup();
      context.dependencies.createAssistantMessageId = () => "partial";
      context.stream.mockImplementation(async function* () {
        yield { type, partId: "part", delta: "字" };
        throw new Error("upstream failed");
      });
      vi.mocked(failGenerationExecution).mockImplementation(async () => {
        expect(context.events.some(event => event.type === "generation.failed"))
          .toBe(false);
        return true;
      });

      await expect(executeChatGeneration(execution, context.dependencies))
        .rejects.toThrow("upstream failed");
      expect(failGenerationExecution).toHaveBeenCalledWith({
        generationId: execution.id,
        errorCode: "CHAT_GENERATION_FAILED",
        partialMessage: { id: "partial", parts: [{ id: "part", type, text: "字" }] },
        now: expect.any(Date),
      });
      expect(context.events.at(-1)?.type).toBe("generation.failed");
      expect(completeGenerationExecution).not.toHaveBeenCalled();
      expect(context.close).toHaveBeenCalledOnce();
      expect(context.unsubscribe).toHaveBeenCalledOnce();
    },
  );

  it("只有工具过程和引用、尚无正文时也保留所有 Parts", async () => {
    const context = setup();
    context.dependencies.createAssistantMessageId = () => "partial";
    const sources: KnowledgeSourceDto[] = [{
      number: 1, chunkId: "chunk", documentId: "doc",
      originalName: "资料.md", page: 1, content: "原文",
    }];
    context.resolve.mockImplementation(async () => ({
      instructions: "system", tools: undefined, activeTools: () => [],
      toPublicToolName: (name: string) => name,
      takeSources: () => sources, close: context.close,
    }));
    context.stream.mockImplementation(async function* () {
      yield { type: "tool-call", partId: "call", toolCallId: "c",
        toolName: "knowledge_search", input: { query: "问题" } };
      yield { type: "tool-result", partId: "result", toolCallId: "c",
        output: { answer: "原文" }, isError: false };
      throw new Error("upstream failed");
    });

    await expect(executeChatGeneration(execution, context.dependencies))
      .rejects.toThrow("upstream failed");
    expect(vi.mocked(failGenerationExecution).mock.calls[0]![0].partialMessage)
      .toEqual({ id: "partial", parts: [
        { id: "call", type: "tool-call", toolCallId: "c",
          toolName: "knowledge_search", input: { query: "问题" } },
        { id: "result", type: "tool-result", toolCallId: "c",
          output: { answer: "原文" }, isError: false },
        { id: "knowledge-generation", type: "knowledge-sources", sources },
      ] });
    expect(context.events.map(event => event.type)).toEqual([
      "generation.started", "tool.call", "tool.result", "knowledge.sources", "generation.failed",
    ]);
  });

  it("取消先于失败落库时由取消路径保存 partial，不发布失败事件", async () => {
    const context = setup();
    context.dependencies.createAssistantMessageId = () => "partial";
    context.stream.mockImplementation(async function* () {
      yield { type: "reasoning", partId: "r", delta: "思" };
      throw new Error("upstream failed");
    });
    vi.mocked(failGenerationExecution).mockImplementation(async () => {
      vi.mocked(isGenerationCancellationRequested).mockResolvedValue(true);
      return false;
    });

    await expect(executeChatGeneration(execution, context.dependencies))
      .resolves.toEqual({ kind: "cancelled", assistantMessageId: "partial" });
    expect(cancelGenerationExecution).toHaveBeenCalledWith({
      generationId: execution.id, assistantMessageId: "partial",
      assistantParts: [{ id: "r", type: "reasoning", text: "思" }],
      now: expect.any(Date),
    });
    expect(context.events.at(-1)?.type).toBe("generation.cancelled");
    expect(context.events.some(event => event.type === "generation.failed")).toBe(false);
  });
});
