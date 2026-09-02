import { describe, expect, it } from "vitest";

import type { ChatModelStreamPart } from "../llm/chat-model";
import { coalesceChatModelStream } from "./delta-coalescer";

async function collect(source: AsyncIterable<ChatModelStreamPart>) {
  const parts: ChatModelStreamPart[] = [];

  for await (const part of source) {
    parts.push(part);
  }

  return parts;
}

describe("Chat delta coalescer", () => {
  it("同类型但不同 partId 的 delta 仍保持边界", async () => {
    async function* source(): AsyncIterable<ChatModelStreamPart> {
      yield { type: "reasoning", partId: "reasoning-1", delta: "第一段" };
      yield { type: "reasoning", partId: "reasoning-2", delta: "第二段" };
      yield { type: "finish", reason: "stop" };
    }

    await expect(
      collect(
        coalesceChatModelStream(source(), {
          maxDelayMs: 10_000,
          maxCharacters: 128,
        }),
      ),
    ).resolves.toEqual([
      { type: "reasoning", partId: "reasoning-1", delta: "第一段" },
      { type: "reasoning", partId: "reasoning-2", delta: "第二段" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("立即发送首段，并按大小无损合并且保持类型顺序", async () => {
    async function* source(): AsyncIterable<ChatModelStreamPart> {
      yield { type: "text", partId: "text-1", delta: "A" };
      yield { type: "text", partId: "text-1", delta: "B" };
      yield { type: "text", partId: "text-1", delta: "C" };
      yield { type: "reasoning", partId: "reasoning-1", delta: "R1" };
      yield { type: "reasoning", partId: "reasoning-1", delta: "R2" };
      yield { type: "text", partId: "text-2", delta: "D" };
      yield { type: "finish", reason: "stop" };
    }

    await expect(
      collect(
        coalesceChatModelStream(source(), {
          maxDelayMs: 10_000,
          maxCharacters: 2,
        }),
      ),
    ).resolves.toEqual([
      { type: "text", partId: "text-1", delta: "A" },
      { type: "text", partId: "text-1", delta: "BC" },
      { type: "reasoning", partId: "reasoning-1", delta: "R1R2" },
      { type: "text", partId: "text-2", delta: "D" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("上游暂停时按时间刷新，结束前不遗留 buffer", async () => {
    let releaseSource!: () => void;
    const sourceGate = new Promise<void>((resolve) => {
      releaseSource = resolve;
    });

    async function* source(): AsyncIterable<ChatModelStreamPart> {
      yield { type: "text", partId: "text-1", delta: "首" };
      yield { type: "text", partId: "text-1", delta: "次" };
      await sourceGate;
      yield { type: "finish", reason: "stop" };
    }

    const iterator = coalesceChatModelStream(source(), {
      maxDelayMs: 5,
      maxCharacters: 128,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "text", partId: "text-1", delta: "首" },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "text", partId: "text-1", delta: "次" },
    });
    releaseSource();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "finish", reason: "stop" },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("上游抛错前先刷新已经收到的字符", async () => {
    async function* source(): AsyncIterable<ChatModelStreamPart> {
      yield { type: "text", partId: "text-1", delta: "首" };
      yield { type: "text", partId: "text-1", delta: "不能丢" };
      throw new Error("provider failed");
    }

    const iterator = coalesceChatModelStream(source(), {
      maxDelayMs: 10_000,
      maxCharacters: 128,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "text", partId: "text-1", delta: "首" },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "text", partId: "text-1", delta: "不能丢" },
    });
    await expect(iterator.next()).rejects.toThrow("provider failed");
  });

  it("Tool 事件会先刷新 delta，并保持调用与结果顺序", async () => {
    async function* source(): AsyncIterable<ChatModelStreamPart> {
      yield { type: "text", partId: "text-1", delta: "先" };
      yield { type: "text", partId: "text-1", delta: "查" };
      yield {
        type: "tool-call",
        partId: "tool-call:call-1",
        toolCallId: "call-1",
        toolName: "web_search",
        input: { query: "最新信息" },
      };
      yield {
        type: "tool-result",
        partId: "tool-result:call-1",
        toolCallId: "call-1",
        output: { results: [] },
        isError: false,
      };
      yield { type: "text", partId: "text-2", delta: "结论" };
      yield { type: "finish", reason: "stop" };
    }

    await expect(
      collect(
        coalesceChatModelStream(source(), {
          maxDelayMs: 10_000,
          maxCharacters: 128,
        }),
      ),
    ).resolves.toEqual([
      { type: "text", partId: "text-1", delta: "先" },
      { type: "text", partId: "text-1", delta: "查" },
      {
        type: "tool-call",
        partId: "tool-call:call-1",
        toolCallId: "call-1",
        toolName: "web_search",
        input: { query: "最新信息" },
      },
      {
        type: "tool-result",
        partId: "tool-result:call-1",
        toolCallId: "call-1",
        output: { results: [] },
        isError: false,
      },
      { type: "text", partId: "text-2", delta: "结论" },
      { type: "finish", reason: "stop" },
    ]);
  });
});
