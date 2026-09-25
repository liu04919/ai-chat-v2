import { describe, expect, it } from "vitest";
import { getChatGenerationDisplay } from "./chat-generation-display";
import { createGenerationProjection } from "./generation-projection";

const failed = {
  ...createGenerationProjection("c1", "g1"),
  status: "failed" as const,
  parts: [{ id: "r1", type: "reasoning" as const, text: "思" }],
};
const latestGeneration = { id: "g1", status: "failed" as const };
const input = {
  activeGeneration: null,
  latestGeneration,
  projection: failed,
  isSubmitting: false,
};

describe("聊天失败展示", () => {
  it("刷新后没有投影也能从 latestGeneration 恢复提示，不伪造空消息", () => {
    expect(getChatGenerationDisplay({ ...input, projection: null }))
      .toEqual({ projection: null, failed: true });
  });

  it("历史已包含失败 partial 时隐藏投影，避免显示两遍", () => {
    expect(getChatGenerationDisplay(input))
      .toEqual({ projection: null, failed: true });
  });

  it("终态历史尚未同步或同步失败时保留流式内容和失败提示", () => {
    expect(getChatGenerationDisplay({
      ...input,
      activeGeneration: { id: "g1", status: "running", cancelRequestedAt: null },
      latestGeneration: { id: "g1", status: "running" },
    })).toEqual({ projection: failed, failed: false });
  });

  it("发送或重新生成期间隐藏旧提示，命令失败后可恢复", () => {
    expect(getChatGenerationDisplay({ ...input, isSubmitting: true }))
      .toEqual({ projection: null, failed: false });
    expect(getChatGenerationDisplay(input))
      .toEqual({ projection: null, failed: true });
  });

  it("新任务不继承上一轮的失败投影", () => {
    expect(getChatGenerationDisplay({
      ...input,
      activeGeneration: { id: "g2", status: "queued", cancelRequestedAt: null },
      latestGeneration: { id: "g2", status: "queued" },
    })).toEqual({ projection: null, failed: false });
  });

  it.each(["completed", "cancelled"] as const)(
    "新任务 %s 后不再显示旧失败提示", (status) => {
      expect(getChatGenerationDisplay({
        ...input, latestGeneration: { id: "g2", status },
      })).toEqual({ projection: null, failed: false });
    },
  );

  it.each(["cancelled", "connection-error"] as const)(
    "保留当前任务原有的 %s 提示", (status) => {
      const projection = { ...failed, status };
      expect(getChatGenerationDisplay({
        ...input, latestGeneration: { id: "g1", status: "cancelled" }, projection,
      })).toEqual({ projection, failed: false });
    },
  );
});
