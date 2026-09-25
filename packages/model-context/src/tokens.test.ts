import { describe, expect, it } from "vitest";
import {
  countStoredMessage,
  countModelMessages,
  countTextTokens,
  MESSAGE_TOKEN_VERSION,
} from "./tokens";
import { toModelMessages } from "./history";
import type { ChatModelMessage } from "./types";

describe("存储与回放共用 token 投影", () => {
  it("助手原文由 role 区分，不再添加历史前缀；计数使用同一投影", () => {
    const message = {
      role: "assistant" as const,
      parts: [{ id: "answer", type: "text" as const, text: "原始回答" }],
    };
    const projected = [
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "原始回答" }],
      },
    ];
    expect(toModelMessages(message)).toEqual(projected);
    expect(countStoredMessage(message)).toEqual({
      version: MESSAGE_TOKEN_VERSION,
      textTokens: countModelMessages(projected),
    });
  });

  it("用户文本与实际 ModelMessage 一致，附件内容单独累加", () => {
    const count = countStoredMessage({
      role: "user",
      parts: [
        { type: "text", text: "分析这个文件" },
        { type: "attachment", attachmentId: "file" },
      ],
    });
    const projected = toModelMessages({
      role: "user",
      parts: [
        { type: "text", text: "分析这个文件" },
        {
          type: "file",
          url: "https://example.test/file",
          mediaType: "application/pdf",
        },
      ],
    });
    expect(count.version).toBe(MESSAGE_TOKEN_VERSION);
    expect(count.textTokens + 1234).toBe(
      countModelMessages(projected, () => 1234),
    );
  });

  it("计数包含可见思考和缺失工具结果的修复文本，排除旧 RAG 原文", () => {
    const message: Extract<ChatModelMessage, { role: "assistant" }> = {
      role: "assistant",
      parts: [
        {
          id: "r",
          type: "reasoning" as const,
          text: "visible thought ".repeat(10000),
        },
        {
          id: "k",
          type: "tool-call" as const,
          toolCallId: "k",
          toolName: "search_knowledge",
          input: { query: "old" },
        },
        {
          id: "kr",
          type: "tool-result" as const,
          toolCallId: "k",
          output: { text: "private ".repeat(10000) },
          isError: false,
        },
        {
          id: "m",
          type: "tool-call" as const,
          toolCallId: "m",
          toolName: "mail.send",
          input: { to: "test@example.com" },
        },
        { id: "t", type: "text" as const, text: "已开始处理" },
      ],
    };
    const projected = toModelMessages(message);
    expect(JSON.stringify(projected)).toContain("TOOL_RESULT_UNAVAILABLE");
    expect(JSON.stringify(projected)).toContain("历史可见思考");
    expect(JSON.stringify(projected)).toContain("visible thought");
    expect(JSON.stringify(projected)).not.toContain("private ");
    expect(countStoredMessage(message).textTokens).toBe(
      countModelMessages(projected),
    );
    const withoutReasoning = countStoredMessage({
      ...message,
      parts: message.parts.filter((part) => part.type !== "reasoning"),
    }).textTokens;
    expect(withoutReasoning).toBeLessThan(300);
    expect(countStoredMessage(message).textTokens).toBeGreaterThan(withoutReasoning);
    expect(countStoredMessage(message).textTokens).toBeGreaterThan(
      countTextTokens("已开始处理"),
    );
  });
});
