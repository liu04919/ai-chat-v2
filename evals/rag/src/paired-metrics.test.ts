import { describe, expect, it } from "vitest";
import { pairedInterval, percentile } from "./paired-metrics";

describe("配对指标", () => {
  it("相同结果没有伪造提升，常数差异退化为常数区间", () => {
    expect(pairedInterval([0, 0, 0])).toEqual([0, 0]);
    expect(pairedInterval([0.25, 0.25, 0.25])).toEqual([0.25, 0.25]);
  });
  it("固定种子可复现，混合正负差异保留不确定性", () => {
    const input = [-1, 0, 0.25, 0.75];
    const interval = pairedInterval(input);
    expect(interval).toEqual(pairedInterval(input));
    expect(interval[0]).toBeLessThan(0);
    expect(interval[1]).toBeGreaterThan(0);
    expect(input).toEqual([-1, 0, 0.25, 0.75]);
  });
  it("未知统计不当作零", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(() => pairedInterval([])).toThrow("INVALID_PAIRED_SAMPLE");
    expect(() => pairedInterval([NaN])).toThrow("INVALID_PAIRED_SAMPLE");
  });
});
