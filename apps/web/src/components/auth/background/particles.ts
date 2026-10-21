import { ART_HEIGHT, ART_WIDTH, smooth, type Viewport } from "./geometry";
import { handPetalAt, type Pointer } from "./motion";

export function createParticles(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D 不可用");
  const ctx = context;
  let seed = 1809;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const petals = Array.from({ length: 18 }, () => ({ x: random() * ART_WIDTH, y: random() * ART_HEIGHT, r: 5 + random() * 10, vx: 9 + random() * 13, vy: 12 + random() * 16, phase: random() * Math.PI * 2, spin: random() * .8 + .45, alpha: .12 + random() * .23 }));
  const motes = Array.from({ length: 32 }, () => ({ x: random() * ART_WIDTH, y: random() * ART_HEIGHT, r: .7 + random() * 1.5, phase: random() * 6.28 }));

  function drawPetal(x: number, y: number, r: number, angle: number, alpha: number, phase: number) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(.4 + .6 * Math.abs(Math.sin(phase)), 1);
    ctx.globalAlpha = alpha;
    const gradient = ctx.createLinearGradient(-r, -r, r, r);
    gradient.addColorStop(0, "#f8eaff");
    gradient.addColorStop(.48, "#c1a3e0");
    gradient.addColorStop(1, "#a489c7");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.bezierCurveTo(r * .85, -r * .4, r * .7, r * .65, 0, r);
    ctx.bezierCurveTo(-r * .5, r * .1, -r * .48, -r * .65, 0, -r);
    ctx.fill();
    ctx.strokeStyle = "#fff7";
    ctx.lineWidth = .5;
    ctx.beginPath();
    ctx.moveTo(0, -r * .7);
    ctx.quadraticCurveTo(-r * .18, 0, 0, r * .7);
    ctx.stroke();
    ctx.restore();
  }

  return function draw(view: Viewport, time: number, pointer: Pointer) {
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.save();
    ctx.translate(view.originX, view.originY);
    ctx.scale(view.scale, view.scale);
    ctx.beginPath();
    ctx.rect(0, 0, ART_WIDTH, ART_HEIGHT);
    ctx.clip();
    for (const mote of motes) {
      const x = mote.x + Math.sin(time * .2 + mote.phase) * 20;
      const y = (mote.y - time * 3 % ART_HEIGHT + ART_HEIGHT) % ART_HEIGHT;
      ctx.globalAlpha = (.2 + .2 * Math.sin(time * .8 + mote.phase)) * .8;
      ctx.fillStyle = "#fffef5";
      ctx.beginPath();
      ctx.arc(x, y, mote.r, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const petal of petals) {
      const x = ((petal.x + time * petal.vx + Math.sin(time * .7 + petal.phase) * 22) % (ART_WIDTH + 70) + ART_WIDTH + 70) % (ART_WIDTH + 70) - 35;
      const y = (petal.y + time * petal.vy) % (ART_HEIGHT + 70) - 35;
      const alpha = petal.alpha * smooth(0, 70, y) * (1 - smooth(ART_HEIGHT - 90, ART_HEIGHT + 20, y));
      drawPetal(x, y, petal.r, petal.phase + time * petal.spin, alpha, petal.phase + time * .9);
    }
    const hand = handPetalAt(time, pointer);
    const glow = ctx.createRadialGradient(hand.x, hand.y, 0, hand.x, hand.y, 43);
    glow.addColorStop(0, `rgba(235,219,255,${hand.alpha * (.07 + .08 * smooth(.75, 1, hand.progress))})`);
    glow.addColorStop(1, "rgba(245,225,255,0)");
    ctx.globalAlpha = 1;
    ctx.fillStyle = glow;
    ctx.fillRect(hand.x - 43, hand.y - 43, 86, 86);
    ctx.restore();
  };
}
