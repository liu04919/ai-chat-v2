import { smooth } from "./geometry";

type Point = readonly [number, number];
export type Pointer = { x: number; y: number };

const blinkMoments = [2.7, 6.9, 11.4, 11.8, 17.0, 22.6, 27.4, 31.6, 31.97];
export function blinkAt(time: number) {
  const t = time % 37;
  for (const start of blinkMoments) {
    const age = t - start;
    if (age < 0 || age >= .34) continue;
    if (age < .095) return smooth(0, .095, age);
    if (age < .145) return 1;
    return 1 - smooth(.145, .34, age);
  }
  return 0;
}
function bezier(a: Point, b: Point, c: Point, d: Point, t: number): [number, number] {
  const s = 1 - t;
  return [
    s * s * s * a[0] + 3 * s * s * t * b[0] + 3 * s * t * t * c[0] + t * t * t * d[0],
    s * s * s * a[1] + 3 * s * s * t * b[1] + 3 * s * t * t * c[1] + t * t * t * d[1],
  ];
}
export function handPetalAt(time: number, pointer: Pointer, strength = 1) {
  const phase = ((time + 4.4) % 12) / 12, q = Math.min(phase / .78, 1);
  let p;
  if (q < .46) p = bezier([691, 45], [730, 83], [654, 135], [715, 183], q / .46);
  else if (q < .79) p = bezier([715, 183], [770, 205], [869, 219], [839, 287], (q - .46) / .33);
  else p = bezier([839, 287], [833, 339], [809, 365], [791, 389], (q - .79) / .21);
  const settled = smooth(.89, 1, q), wind = Math.sin(q * 13.8) * 6 * (1 - settled);
  // 接近掌心时叠加手部的同一呼吸位移，落点随手一起移动。
  const attach = smooth(.75, 1, q) * strength;
  p[0] += wind + (Math.sin(time * .7) * .8 + pointer.x * 1.7) * attach;
  p[1] += (-Math.sin(time * 1.48) * 1.9 + Math.sin(time * .62) * .8 + pointer.y * .85) * attach;
  return {
    x: p[0], y: p[1],
    size: .20 + .78 * Math.pow(q, .9),
    rotation: Math.sin(q * 8.5) * .45 + settled * 1.23,
    flip: .65 + .35 * Math.abs(Math.sin(q * 10.2 + .6)),
    flatten: 1 - settled * .52,
    alpha: smooth(0, .095, phase) * (1 - smooth(.89, 1, phase)),
    phase, progress: q,
    stage: q < 1 ? "approaching" : phase < .89 ? "resting" : "fading",
  };
}
export const foregroundPetals = [
  { source: [1542, 731, 49, 42], x: 1531, y: 733, dx: 35, dy: 24, speed: .48, phase: .5 },
  { source: [1550, 583, 50, 44], x: 1531, y: 582, dx: 28, dy: 31, speed: .43, phase: 2.0 },
  { source: [1390, 800, 32, 29], x: 1382, y: 802, dx: 34, dy: 22, speed: .57, phase: 1.2 },
  { source: [1220, 864, 32, 29], x: 1228, y: 859, dx: 27, dy: 24, speed: .51, phase: 3.3 },
  { source: [1364, 900, 31, 26], x: 1361, y: 899, dx: 35, dy: 20, speed: .46, phase: 4.4 }
];
export function foregroundAt(p: typeof foregroundPetals[number], time: number, strength = 1) {
  return {
    x: p.x + Math.sin(time * p.speed + p.phase) * p.dx * strength,
    y: p.y + Math.cos(time * p.speed * .73 + p.phase) * p.dy * strength,
    rotation: Math.sin(time * .48 + p.phase) * .5 * strength,
  };
}
