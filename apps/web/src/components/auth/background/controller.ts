import { clamp, getViewport } from "./geometry";
import { createParticles } from "./particles";
import { createRenderer } from "./renderer";

export function createBackground({ container, artwork, particles, image, repair, onFailure }: {
  container: HTMLElement;
  artwork: HTMLCanvasElement;
  particles: HTMLCanvasElement;
  image: ImageBitmap;
  repair: ImageBitmap;
  onFailure: () => void;
}) {
  const drawParticles = createParticles(particles);
  const renderer = createRenderer(artwork, image, repair);
  const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };
  let bounds = container.getBoundingClientRect();
  let view = getViewport(bounds.width, bounds.height, window.devicePixelRatio);
  let frame = 0, last = 0, time = 0;
  let paused = false, disposed = false;
  const shouldRun = () => !disposed && !paused && !document.hidden;

  function draw() {
    renderer.draw(view, time, pointer);
    drawParticles(view, time, pointer);
  }
  function tick(now: number) {
    frame = 0;
    if (!shouldRun()) return;
    // 装饰背景限制到约 30 fps；鼠标与时间只存在闭包里，不触发 React 渲染。
    if (last && now - last < 1000 / 30 - .5) {
      frame = requestAnimationFrame(tick);
      return;
    }
    const dt = last ? Math.min((now - last) / 1000, .05) : 0;
    last = now;
    time += dt;
    const response = 1 - Math.exp(-dt * 3.7);
    pointer.x += (pointer.targetX - pointer.x) * response;
    pointer.y += (pointer.targetY - pointer.y) * response;
    draw();
    frame = requestAnimationFrame(tick);
  }
  function resume() {
    if (!frame && shouldRun()) frame = requestAnimationFrame(tick);
  }
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
  }
  function resize() {
    bounds = container.getBoundingClientRect();
    if (!bounds.width || !bounds.height || disposed) return;
    view = getViewport(bounds.width, bounds.height, window.devicePixelRatio);
    artwork.width = particles.width = Math.round(view.width * view.dpr);
    artwork.height = particles.height = Math.round(view.height * view.dpr);
    if (!document.hidden) draw();
  }
  function move(event: PointerEvent) {
    if (event.pointerType === "touch") return;
    pointer.targetX = clamp(((event.clientX - bounds.left) / view.width - .5) * 2, -1, 1);
    pointer.targetY = clamp(((event.clientY - bounds.top) / view.height - .5) * 2, -1, 1);
  }
  function leave() { pointer.targetX = pointer.targetY = 0; }
  function visibility() { stop(); resume(); }
  function contextLost(event: Event) {
    event.preventDefault();
    dispose();
    onFailure();
  }
  const observer = new ResizeObserver(resize);
  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    observer.disconnect();
    window.removeEventListener("pointermove", move);
    document.documentElement.removeEventListener("pointerleave", leave);
    document.removeEventListener("visibilitychange", visibility);
    artwork.removeEventListener("webglcontextlost", contextLost);
    renderer.dispose();
    // 删除纹理/缓冲之外也释放画布的像素存储。
    artwork.width = artwork.height = particles.width = particles.height = 0;
  }
  try {
    resize();
    observer.observe(container);
    window.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    document.addEventListener("visibilitychange", visibility);
    artwork.addEventListener("webglcontextlost", contextLost);
    resume();
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    setPaused(value: boolean) { paused = value; stop(); resume(); },
    dispose,
  };
}
