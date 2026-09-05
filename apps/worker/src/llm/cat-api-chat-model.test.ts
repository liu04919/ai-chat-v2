import { tool } from "ai";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import type { ChatModelMessage, ChatModelStreamPart } from "./chat-model";
import { createCatApiChatModel } from "./cat-api-chat-model";

function sseEvent(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function createResponsesStream(): string {
  return [
    sseEvent({
      type: "response.created",
      response: {
        id: "response_example",
        created_at: 1_787_900_000,
        model: "gpt-5.6-sol",
        service_tier: "default",
      },
    }),
    sseEvent({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "reasoning_example",
      },
    }),
    sseEvent({
      type: "response.reasoning_summary_part.added",
      item_id: "reasoning_example",
      output_index: 0,
      summary_index: 0,
    }),
    sseEvent({
      type: "response.reasoning_summary_text.delta",
      item_id: "reasoning_example",
      output_index: 0,
      summary_index: 0,
      delta: "先读取附件。",
    }),
    sseEvent({
      type: "response.reasoning_summary_part.done",
      item_id: "reasoning_example",
      output_index: 0,
      summary_index: 0,
    }),
    sseEvent({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "reasoning_example",
      },
    }),
    sseEvent({
      type: "response.output_item.added",
      output_index: 1,
      item: {
        type: "message",
        id: "message_example",
        phase: "final_answer",
      },
    }),
    sseEvent({
      type: "response.output_text.delta",
      item_id: "message_example",
      output_index: 1,
      delta: "附件",
    }),
    sseEvent({
      type: "response.output_text.delta",
      item_id: "message_example",
      output_index: 1,
      delta: "已读取。",
    }),
    sseEvent({
      type: "response.output_item.done",
      output_index: 1,
      item: {
        type: "message",
        id: "message_example",
        phase: "final_answer",
      },
    }),
    sseEvent({
      type: "response.completed",
      response: {
        incomplete_details: null,
        usage: {
          input_tokens: 12,
          output_tokens: 8,
        },
        reasoning: null,
        service_tier: "default",
      },
    }),
    "data: [DONE]\n\n",
  ].join("");
}

function responseCompleted(): string {
  return sseEvent({
    type: "response.completed",
    response: {
      incomplete_details: null,
      usage: { input_tokens: 12, output_tokens: 8 },
      reasoning: null,
      service_tier: "default",
    },
  });
}

function createToolCallStream(): string {
  return [
    sseEvent({
      type: "response.created",
      response: {
        id: "response_tool",
        created_at: 1_787_900_000,
        model: "gpt-5.6-sol",
        service_tier: "default",
      },
    }),
    sseEvent({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "function_item",
        call_id: "call_search",
        name: "web_search",
        arguments: "",
      },
    }),
    sseEvent({
      type: "response.function_call_arguments.delta",
      item_id: "function_item",
      output_index: 0,
      delta: "{\"query\":\"Redis latest\"}",
    }),
    sseEvent({
      type: "response.function_call_arguments.done",
      item_id: "function_item",
      output_index: 0,
      arguments: "{\"query\":\"Redis latest\"}",
    }),
    sseEvent({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "function_item",
        call_id: "call_search",
        name: "web_search",
        arguments: "{\"query\":\"Redis latest\"}",
        status: "completed",
      },
    }),
    responseCompleted(),
    "data: [DONE]\n\n",
  ].join("");
}

function createFinalAnswerStream(): string {
  return [
    sseEvent({
      type: "response.created",
      response: {
        id: "response_final",
        created_at: 1_787_900_001,
        model: "gpt-5.6-sol",
        service_tier: "default",
      },
    }),
    sseEvent({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "message_final", phase: "final_answer" },
    }),
    sseEvent({
      type: "response.output_text.delta",
      item_id: "message_final",
      output_index: 0,
      delta: "查询完成。",
    }),
    sseEvent({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "message_final", phase: "final_answer" },
    }),
    responseCompleted(),
    "data: [DONE]\n\n",
  ].join("");
}

describe("CatAPI Chat Adapter", () => {
  it.each([1, 2])("为 %i 个无结果调用补齐历史，保留文字和已有结果，不重新执行工具", async (count) => {
    const history: Extract<ChatModelMessage, { role: "assistant" }> = {
      role: "assistant",
      parts: [
        { id: "partial", type: "text", text: "已经生成的部分回答" },
        { id: "reasoning", type: "reasoning", text: "正在查询" },
        { id: "done-call", type: "tool-call", toolCallId: "done", toolName: "web_search", input: {} },
        ...Array.from({ length: count }, (_, index) => ({
          id: `pending-${index}`, type: "tool-call" as const,
          toolCallId: `pending-${index}`, toolName: "web_search", input: { query: "test" },
        })),
        { id: "done-result", type: "tool-result", toolCallId: "done", output: { answer: "real result" }, isError: false },
      ],
    };
    const original = structuredClone(history);
    const requests: Request[] = [];
    const execute = vi.fn();
    const model = createCatApiChatModel({
      baseUrl: "https://example.test/v1", apiKey: "test", modelId: "test-model",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(createFinalAnswerStream(), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const parts: ChatModelStreamPart[] = [];
    for await (const part of model.stream({
      messages: [
        { role: "user", parts: [{ type: "text", text: "查询" }] }, history,
        { role: "user", parts: [{ type: "text", text: "继续" }] },
      ],
      reasoningEffort: "low",
      tools: { web_search: tool({ inputSchema: z.object({}), execute }) },
    })) parts.push(part);

    expect(requests).toHaveLength(1);
    const body = await requests[0]!.json() as {
      input: Array<{ type: string; call_id: string; output: string }>;
    };
    const outputs = body.input.filter((item: { type: string }) => item.type === "function_call_output");
    expect(outputs).toHaveLength(count + 1);
    expect(outputs.find((item) => item.call_id === "done")?.output).toBe(JSON.stringify({ answer: "real result" }));
    for (let index = 0; index < count; index++) {
      expect(JSON.parse(outputs.find((item) => item.call_id === `pending-${index}`)!.output))
        .toMatchObject({ code: "TOOL_RESULT_UNAVAILABLE" });
    }
    expect(JSON.stringify(body.input)).toContain("已经生成的部分回答");
    expect(JSON.stringify(body.input)).toContain("正在查询");
    expect(parts).toContainEqual({ type: "text", partId: "message_final", delta: "查询完成。" });
    expect(execute).not.toHaveBeenCalled();
    expect(history).toEqual(original);
  });

  it("工具执行中停止，只有 Tool Call 的历史也能继续下一轮", async () => {
    const controller = new AbortController();
    const model = createCatApiChatModel({
      baseUrl: "https://example.test/v1", apiKey: "test", modelId: "test-model",
      fetch: async () => new Response(createToolCallStream(), { headers: { "content-type": "text/event-stream" } }),
    });
    const history: Extract<ChatModelMessage, { role: "assistant" }> = { role: "assistant", parts: [] };
    try {
      for await (const part of model.stream({
        messages: [{ role: "user", parts: [{ type: "text", text: "查询" }] }],
        reasoningEffort: "low", abortSignal: controller.signal,
        tools: { web_search: tool({
          inputSchema: z.object({ query: z.string() }),
          execute: async () => new Promise((_resolve, reject) => {
            if (controller.signal.aborted) reject(controller.signal.reason);
            else controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
          }),
        }) },
      })) {
        if (part.type === "tool-call") {
          history.parts.push({ id: part.partId, type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: z.json().parse(part.input) });
          controller.abort(new Error("用户停止"));
        }
      }
    } catch (error) {
      expect((error as Error).message).toContain("用户停止");
    }
    expect(history.parts).toHaveLength(1);
    const fetch = vi.fn(async () => new Response(createFinalAnswerStream(), { headers: { "content-type": "text/event-stream" } }));
    const next = createCatApiChatModel({ baseUrl: "https://example.test/v1", apiKey: "test", modelId: "test-model", fetch });
    const parts: ChatModelStreamPart[] = [];
    for await (const part of next.stream({
      messages: [history, { role: "user", parts: [{ type: "text", text: "继续" }] }], reasoningEffort: "low",
    })) parts.push(part);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(parts).toContainEqual({ type: "text", partId: "message_final", delta: "查询完成。" });
  });

  it("使用 Responses API，并把 SDK stream part 映射为内部协议", async () => {
    let capturedRequest: Request | undefined;
    const model = createCatApiChatModel({
      baseUrl: "https://maomiapi.com/v1/",
      apiKey: "test-api-key",
      modelId: "gpt-5.6-sol",
      fetch: async (input, init) => {
        capturedRequest = new Request(input, init);
        return new Response(createResponsesStream(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const parts: ChatModelStreamPart[] = [];

    for await (const part of model.stream({
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "请读取附件" },
            {
              type: "file",
              url: "https://files.example/image.png?signature=image",
              mediaType: "image/png",
              filename: "image.png",
            },
            {
              type: "file",
              url: "https://files.example/report.pdf?signature=pdf",
              mediaType: "application/pdf",
              filename: "report.pdf",
            },
          ],
        },
        {
          role: "assistant",
          parts: [
            { id: "old-reasoning", type: "reasoning", text: "先检查附件类型" },
            { id: "old-text", type: "text", text: "我会读取。" },
          ],
        },
      ],
      reasoningEffort: "medium",
    })) {
      parts.push(part);
    }

    expect(parts).toEqual([
      {
        type: "reasoning",
        partId: "reasoning_example:0",
        delta: "先读取附件。",
      },
      { type: "text", partId: "message_example", delta: "附件" },
      { type: "text", partId: "message_example", delta: "已读取。" },
      {
        type: "finish",
        reason: "stop",
      },
    ]);
    expect(capturedRequest).toBeDefined();
    expect(capturedRequest?.url).toBe("https://maomiapi.com/v1/responses");
    expect(capturedRequest?.method).toBe("POST");
    expect(capturedRequest?.headers.get("authorization")).toBe(
      "Bearer test-api-key",
    );

    const body = (await capturedRequest?.json()) as {
      model: string;
      stream: boolean;
      store: boolean;
      reasoning: { effort: string; summary: string };
      input: Array<{ role: string; content: unknown }>;
    };

    expect(body).toMatchObject({
      model: "gpt-5.6-sol",
      stream: true,
      store: false,
      reasoning: { effort: "medium", summary: "auto" },
    });
    expect(body.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "请读取附件" },
          {
            type: "input_image",
            image_url: "https://files.example/image.png?signature=image",
          },
          {
            type: "input_file",
            file_url: "https://files.example/report.pdf?signature=pdf",
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "[上一轮展示给用户的思考摘要]\n先检查附件类型",
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "[上一轮助手输出]\n我会读取。",
          },
        ],
      },
    ]);
  });

  it("把 SDK stream error 抛给 Worker 编排层", async () => {
    const model = createCatApiChatModel({
      baseUrl: "https://maomiapi.com/v1",
      apiKey: "test-api-key",
      modelId: "gpt-5.6-sol",
      fetch: async () =>
        new Response(
          sseEvent({
            type: "error",
            sequence_number: 1,
            code: "upstream_error",
            message: "provider failed",
            param: null,
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
    });

    await expect(async () => {
      for await (const part of model.stream({
        messages: [{ role: "user", parts: [{ type: "text", text: "你好" }] }],
        reasoningEffort: "low",
      })) {
        // 读取完整 stream 才能触发流内错误。
        void part;
      }
    }).rejects.toThrow("provider failed");
  });

  it("执行 Tool 后继续第二步，并把调用与结果映射到内部流", async () => {
    const requests: Request[] = [];
    const execute = vi.fn(async ({ query }: { query: string }) => ({
      query,
      results: [{ title: "Redis", url: "https://redis.io/" }],
    }));
    const model = createCatApiChatModel({
      baseUrl: "https://maomiapi.com/v1",
      apiKey: "test-api-key",
      modelId: "gpt-5.6-sol",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(
          requests.length === 1
            ? createToolCallStream()
            : createFinalAnswerStream(),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });
    const parts: ChatModelStreamPart[] = [];

    for await (const part of model.stream({
      messages: [
        { role: "user", parts: [{ type: "text", text: "查一下 Redis" }] },
      ],
      reasoningEffort: "low",
      tools: {
        web_search: tool({
          description: "联网搜索",
          inputSchema: z.object({ query: z.string() }),
          execute,
        }),
      },
    })) {
      parts.push(part);
    }

    expect(execute).toHaveBeenCalledWith(
      { query: "Redis latest" },
      expect.objectContaining({ toolCallId: "call_search" }),
    );
    expect(parts).toEqual([
      {
        type: "tool-call",
        partId: "tool-call:call_search",
        toolCallId: "call_search",
        toolName: "web_search",
        input: { query: "Redis latest" },
      },
      {
        type: "tool-result",
        partId: "tool-result:call_search",
        toolCallId: "call_search",
        output: {
          query: "Redis latest",
          results: [{ title: "Redis", url: "https://redis.io/" }],
        },
        isError: false,
      },
      { type: "text", partId: "message_final", delta: "查询完成。" },
      { type: "finish", reason: "stop" },
    ]);
    expect(requests).toHaveLength(2);
    const secondBody = (await requests[1]?.json()) as {
      input: Array<Record<string, unknown>>;
    };
    expect(secondBody.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call",
          call_id: "call_search",
          name: "web_search",
        }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_search",
        }),
      ]),
    );
  });

  it("下一轮会把已落库的 Tool Call 与 Tool Result 重建进上下文", async () => {
    let capturedRequest: Request | undefined;
    const model = createCatApiChatModel({
      baseUrl: "https://maomiapi.com/v1",
      apiKey: "test-api-key",
      modelId: "gpt-5.6-sol",
      fetch: async (input, init) => {
        capturedRequest = new Request(input, init);
        return new Response(createFinalAnswerStream(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    for await (const part of model.stream({
      messages: [
        { role: "user", parts: [{ type: "text", text: "查天气" }] },
        {
          role: "assistant",
          parts: [
            {
              id: "call-part",
              type: "tool-call",
              toolCallId: "call-weather",
              toolName: "baidu-maps.weather",
              input: { city: "合肥" },
            },
            {
              id: "result-part",
              type: "tool-result",
              toolCallId: "call-weather",
              output: { temperature: 28 },
              isError: false,
            },
            { id: "answer-part", type: "text", text: "合肥 28 度。" },
          ],
        },
        { role: "user", parts: [{ type: "text", text: "那明天呢？" }] },
      ],
      reasoningEffort: "low",
    })) {
      void part;
    }

    const body = (await capturedRequest?.json()) as {
      input: Array<Record<string, unknown>>;
    };
    expect(body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call",
          call_id: "call-weather",
          name: "mcp__baidu-maps__weather",
          arguments: "{\"city\":\"合肥\"}",
        }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call-weather",
          output: "{\"temperature\":28}",
        }),
      ]),
    );
  });
});
