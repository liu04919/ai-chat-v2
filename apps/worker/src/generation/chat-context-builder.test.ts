import { describe, expect, it, vi } from "vitest";

import type { ClaimedGenerationExecution } from "@ai-chat/db";

import { buildChatModelRequest } from "./chat-context-builder";

const execution: ClaimedGenerationExecution = {
  id: "generation_123",
  userMessageId: "message_3",
  conversationId: "conversation_123",
  ownerId: "owner_123",
  mode: "chat",
  reasoningEffort: "medium",
  tools: { webSearch: false, mcpToolIds: [] },
  messages: [
    {
      id: "message_1",
      role: "user",
      sequence: 0,
      parts: [
        { type: "text", text: "读取附件" },
        { type: "attachment", attachmentId: "attachment_123" },
      ],
    },
    {
      id: "message_2",
      role: "assistant",
      sequence: 1,
      parts: [
        { id: "reasoning_1", type: "reasoning", text: "先分析问题" },
        { id: "text_1", type: "text", text: "第一轮回答" },
      ],
    },
    {
      id: "message_3",
      role: "user",
      sequence: 2,
      parts: [{ type: "text", text: "继续解释" }],
    },
  ],
  attachments: [
    {
      id: "attachment_123",
      objectKey: "attachments/attachment_123",
      originalName: "example.pdf",
      mediaType: "application/pdf",
      status: "ready",
    },
  ],
};

describe("Chat Context Builder", () => {
  it("按历史顺序映射 Message，并只为 Attachment 生成短期 URL", async () => {
    const createDownloadUrl = vi
      .fn()
      .mockResolvedValue("https://r2.example.com/signed.pdf");

    await expect(
      buildChatModelRequest(execution, { createDownloadUrl }),
    ).resolves.toEqual({
      reasoningEffort: "medium",
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "读取附件" },
            {
              type: "file",
              url: "https://r2.example.com/signed.pdf",
              mediaType: "application/pdf",
              filename: "example.pdf",
            },
          ],
        },
        {
          role: "assistant",
          parts: [
            { id: "reasoning_1", type: "reasoning", text: "先分析问题" },
            { id: "text_1", type: "text", text: "第一轮回答" },
          ],
        },
        {
          role: "user",
          parts: [{ type: "text", text: "继续解释" }],
        },
      ],
    });
    expect(createDownloadUrl).toHaveBeenCalledOnce();
    expect(createDownloadUrl).toHaveBeenCalledWith(
      "attachments/attachment_123",
      900,
    );
  });

  it("拒绝缺失或未 ready 的 Attachment", async () => {
    const createDownloadUrl = vi.fn();

    await expect(
      buildChatModelRequest(
        { ...execution, attachments: [] },
        { createDownloadUrl },
      ),
    ).rejects.toThrow("找不到 Attachment attachment_123");
    await expect(
      buildChatModelRequest(
        {
          ...execution,
          attachments: [{ ...execution.attachments[0], status: "pending" }],
        },
        { createDownloadUrl },
      ),
    ).rejects.toThrow("尚未 ready");
  });
});
