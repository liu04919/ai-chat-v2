import { describe, expect, it } from "vitest";

import { ART_HEIGHT, ART_WIDTH, createMesh, getViewport, VERTEX_STRIDE } from "./geometry";
import { blinkAt, handPetalAt } from "./motion";

describe("登录背景的原图绑定与动画", () => {
  it("网格保持原画坐标、索引范围合法且权重有限", () => {
    const { vertices, indices } = createMesh();
    const vertexCount = vertices.length / VERTEX_STRIDE;
    expect(vertexCount).toBe(33_017);
    expect(indices.length).toBe(240 * 136 * 6);
    expect(indices.every(index => index < vertexCount)).toBe(true);
    expect(vertices.every(Number.isFinite)).toBe(true);
    for (let i = 0; i < vertices.length; i += VERTEX_STRIDE) {
      const weights = vertices.slice(i + 2, i + VERTEX_STRIDE);
      expect(weights.every(weight => weight >= 0 && weight <= 1)).toBe(true);
    }
    expect(Array.from(vertices.slice(-VERTEX_STRIDE, -VERTEX_STRIDE + 2))).toEqual([ART_WIDTH, ART_HEIGHT]);
  });

  it("尾巴单独绑定鳞片区域，固定尾根并避开裙摆、花丛和画面边缘", () => {
    const { vertices } = createMesh();
    const tailAt = (x: number, y: number) => {
      const column = Math.round(x / ART_WIDTH * 240);
      const row = Math.round(y / ART_HEIGHT * 136);
      return vertices[(row * 241 + column) * VERTEX_STRIDE + 14];
    };
    expect(tailAt(210, 850)).toBeGreaterThan(.9);
    expect(tailAt(110, 755)).toBeGreaterThan(.3);
    expect(tailAt(140, 680)).toBeLessThan(.02);
    for (const [x, y] of [[225, 740], [320, 850], [60, 860], [446, 256], [0, 750]]) {
      expect(tailAt(x, y)).toBe(0);
    }
  });

  it.each([[1440, 900], [1920, 1080], [1280, 720], [2560, 1440]])("%d × %d 接替静态图时保持 cover / 42%% 构图与像素预算", (width, height) => {
    const view = getViewport(width, height, 2);
    expect(ART_WIDTH * view.scale).toBeGreaterThanOrEqual(width);
    expect(ART_HEIGHT * view.scale).toBeGreaterThanOrEqual(height);
    expect(view.originX).toBeCloseTo((width - ART_WIDTH * view.scale) * .42);
    expect(view.originY).toBeCloseTo((height - ART_HEIGHT * view.scale) / 2);
    expect(width * height * view.dpr * view.dpr).toBeLessThanOrEqual(4_200_001);
  });

  it("保留眨眼节奏，闭眼补图只在眨眼期间使用", () => {
    expect(blinkAt(2)).toBe(0);
    expect(blinkAt(2.82)).toBe(1);
    expect(blinkAt(3.1)).toBe(0);
    expect(blinkAt(39.82)).toBe(1);
  });

  it("花瓣在掌心停留，落点随手部与鼠标移动", () => {
    const resting = handPetalAt(5.5, { x: 0, y: 0 });
    const moved = handPetalAt(5.5, { x: 1, y: 1 });
    expect(resting.stage).toBe("resting");
    expect(resting.progress).toBe(1);
    expect(moved.x - resting.x).toBeCloseTo(1.7);
    expect(moved.y - resting.y).toBeCloseTo(.85);
  });
});
