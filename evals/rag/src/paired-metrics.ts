export const mean = (numbers: number[]) => numbers.reduce((a, b) => a + b, 0) / numbers.length;
export const percentile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * q) - 1)] ?? null;

export function pairedInterval(deltas: number[]) {
  if (!deltas.length || deltas.some((n) => !Number.isFinite(n))) throw new Error("INVALID_PAIRED_SAMPLE");
  let seed = 20260908;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  // 对逐题差值重采样，保留同一道题的配对关系。
  const means = Array.from({ length: 10000 }, () => mean(deltas.map(() => deltas[Math.floor(random() * deltas.length)]!)));
  return [percentile(means, 0.025), percentile(means, 0.975)];
}
