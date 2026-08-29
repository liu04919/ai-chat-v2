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
  it("立即发送首段，并按大小无损合并且保持类型顺序", async () => {
    async function* source(): AsyncIterable<ChatModelStreamPart> {
      yield { type: "text", delta: "A" };
      yield { type: "text", delta: "B" };
      yield { type: "text", delta: "C" };
      yield { type: "reasoning", delta: "R1" };
      yield { type: "reasoning", delta: "R2" };
      yield { type: "text", delta: "D" };
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
      { type: "text", delta: "A" },
      { type: "text", delta: "BC" },
      { type: "reasoning", delta: "R1R2" },
      { type: "text", delta: "D" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("上游暂停时按时间刷新，结束前不遗留 buffer", async () => {
    let releaseSource!: () => void;
    const sourceGate = new Promise<void>((resolve) => {
      releaseSource = resolve;
    });

    async function* source(): AsyncIterable<ChatModelStreamPart> {
      yield { type: "text", delta: "首" };
      yield { type: "text", delta: "次" };
      await sourceGate;
      yield { type: "finish", reason: "stop" };
    }

    const iterator = coalesceChatModelStream(source(), {
      maxDelayMs: 5,
      maxCharacters: 128,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "text", delta: "首" },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "text", delta: "次" },
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
      yield { type: "text", delta: "首" };
      yield { type: "text", delta: "不能丢" };
      throw new Error("provider failed");
    }

    const iterator = coalesceChatModelStream(source(), {
      maxDelayMs: 10_000,
      maxCharacters: 128,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "text", delta: "首" },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "text", delta: "不能丢" },
    });
    await expect(iterator.next()).rejects.toThrow("provider failed");
  });
});
