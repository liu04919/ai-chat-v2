import { describe, expect, it } from "vitest";

import type { ChatModelStreamPart } from "./chat-model";
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
        encrypted_content: "encrypted_reasoning_example",
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
        encrypted_content: "encrypted_reasoning_example",
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

describe("CatAPI Chat Adapter", () => {
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
          providerState: {
            version: 1,
            provider: "openai-responses",
            reasoning: [
              {
                partId: "old-reasoning",
                itemId: "old-provider-reasoning",
                encryptedContent: "old-encrypted-reasoning",
              },
            ],
          },
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
        providerState: {
          version: 1,
          provider: "openai-responses",
          reasoning: [
            {
              partId: "reasoning_example:0",
              itemId: "reasoning_example",
              encryptedContent: "encrypted_reasoning_example",
            },
          ],
        },
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
      include: string[];
      input: Array<{ role: string; content: unknown }>;
    };

    expect(body).toMatchObject({
      model: "gpt-5.6-sol",
      stream: true,
      store: false,
      reasoning: { effort: "medium", summary: "auto" },
      include: ["reasoning.encrypted_content"],
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
        type: "reasoning",
        id: "old-provider-reasoning",
        encrypted_content: "old-encrypted-reasoning",
        summary: [],
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
});
