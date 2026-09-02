import { describe, expect, it } from "vitest";
import {
  createGenerationProjection,
  reduceGenerationEvents,
} from "./generation-projection";
import { getImageGenerationStatus as deriveStatus } from "./image-generation-status";

const queued = {
  id: "g1",
  status: "queued" as const,
  cancelRequestedAt: null,
};
const projection = createGenerationProjection("c1", "g1");
const getImageGenerationStatus = (
  input: Omit<Parameters<typeof deriveStatus>[0], "latestGeneration"> &
    Partial<Pick<Parameters<typeof deriveStatus>[0], "latestGeneration">>,
) => deriveStatus({ latestGeneration: null, ...input });

describe("图片生成展示状态", () => {
  it("发送命令尚未确认时显示骨架，不需要伪造持久化消息", () => {
    expect(
      getImageGenerationStatus({
        activeGeneration: null,
        projection: null,
        isSubmitting: true,
      }),
    ).toBe("queued");
    expect(
      getImageGenerationStatus({ activeGeneration: null, projection: null }),
    ).toBeNull();
  });
  it("连接成功不是模型已开始，收到 started 或数据库 running 才切换", () => {
    expect(
      getImageGenerationStatus({ activeGeneration: queued, projection }),
    ).toBe("queued");
    const started = reduceGenerationEvents(projection, [
      { type: "generation.started", generationId: "g1" },
    ]);
    expect(
      getImageGenerationStatus({
        activeGeneration: queued,
        projection: started,
      }),
    ).toBe("running");
    expect(
      getImageGenerationStatus({
        activeGeneration: { ...queued, status: "running" },
        projection: null,
      }),
    ).toBe("running");
  });
  it("完成后保留加载占位，详情刷新后由真实附件接替", () => {
    const completed = reduceGenerationEvents(projection, [
      { type: "generation.completed", generationId: "g1" },
    ]);
    expect(
      getImageGenerationStatus({
        activeGeneration: queued,
        projection: completed,
      }),
    ).toBe("loading");
    expect(
      getImageGenerationStatus({
        activeGeneration: null,
        projection: completed,
      }),
    ).toBeNull();
  });
  it("停止期间及终态都不能继续播放生成动画", () => {
    expect(
      getImageGenerationStatus({
        activeGeneration: queued,
        projection,
        isStopping: true,
      }),
    ).toBe("stopping");
    expect(
      getImageGenerationStatus({
        activeGeneration: {
          ...queued,
          cancelRequestedAt: new Date().toISOString(),
        },
        projection,
      }),
    ).toBe("stopping");
    for (const status of ["failed", "cancelled", "connection-error"] as const) {
      expect(
        getImageGenerationStatus({
          activeGeneration: queued,
          projection: { ...projection, status },
        }),
      ).toBe(status);
    }
  });

  it("没有订阅投影时也能从详情恢复失败与停止，新任务不沿用旧状态", () => {
    for (const status of ["failed", "cancelled"] as const) {
      const latestGeneration = { id: "g1", status };
      expect(
        getImageGenerationStatus({
          activeGeneration: null,
          latestGeneration,
          projection: null,
        }),
      ).toBe(status);
      expect(
        getImageGenerationStatus({
          activeGeneration: queued,
          latestGeneration,
          projection: null,
        }),
      ).toBe(status);
      expect(
        getImageGenerationStatus({
          activeGeneration: { ...queued, id: "g2" },
          latestGeneration,
          projection: null,
        }),
      ).toBe("queued");
      expect(
        getImageGenerationStatus({
          activeGeneration: null,
          latestGeneration,
          projection: null,
          isSubmitting: true,
        }),
      ).toBe("queued");
    }
    expect(
      getImageGenerationStatus({
        activeGeneration: null,
        latestGeneration: { id: "g1", status: "completed" },
        projection: null,
      }),
    ).toBeNull();
  });
});
