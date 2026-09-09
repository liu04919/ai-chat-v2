import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimedGenerationExecution } from "@ai-chat/db";
import {
  cancelGenerationExecution,
  completeGenerationExecution,
  failGenerationExecution,
  isGenerationCancellationRequested,
} from "@ai-chat/db";
import type { GenerationEventDto } from "@ai-chat/contracts";
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
    takeSources: () => [],
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
    expect(context.events.at(-1)?.type).toBe("generation.failed");
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.unsubscribe).toHaveBeenCalledOnce();
  });
});
