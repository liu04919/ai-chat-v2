import { afterEach, describe, expect, it, vi } from "vitest";

const draw = vi.fn(), dispose = vi.fn(), particles = vi.fn();
vi.mock("./renderer", () => ({ createRenderer: () => ({ draw, dispose }) }));
vi.mock("./particles", () => ({ createParticles: () => particles }));

import { createBackground } from "./controller";

function fixture() {
  const doc = Object.assign(new EventTarget(), { hidden: false, documentElement: new EventTarget() });
  const win = Object.assign(new EventTarget(), { devicePixelRatio: 1 });
  const callbacks = new Map<number, FrameRequestCallback>();
  let id = 0;
  const observe = vi.fn(), disconnect = vi.fn();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callbacks.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (value: number) => callbacks.delete(value));
  vi.stubGlobal("ResizeObserver", class { observe = observe; disconnect = disconnect; });
  const artwork = Object.assign(new EventTarget(), { width: 0, height: 0 });
  const overlay = { width: 0, height: 0 };
  const failure = vi.fn();
  const controller = createBackground({
    container: { getBoundingClientRect: () => ({ width: 1440, height: 900, left: 0, top: 0 }) } as unknown as HTMLElement,
    artwork: artwork as unknown as HTMLCanvasElement,
    particles: overlay as HTMLCanvasElement,
    image: {} as ImageBitmap,
    repair: {} as ImageBitmap,
    onFailure: failure,
  });
  function frame(time: number) {
    for (const [key, callback] of [...callbacks]) { callbacks.delete(key); callback(time); }
  }
  return { doc, artwork, controller, frame, callbacks, disconnect, failure };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("动态背景生命周期", () => {
  it("暂停及后台隐藏时停止 rAF，恢复后最多存在一条循环", () => {
    const f = fixture();
    expect(f.callbacks.size).toBe(1);
    f.frame(100);
    expect(draw).toHaveBeenCalledTimes(2);
    f.controller.setPaused(true);
    expect(f.callbacks.size).toBe(0);
    f.controller.setPaused(false);
    f.controller.setPaused(false);
    expect(f.callbacks.size).toBe(1);
    f.doc.hidden = true;
    f.doc.dispatchEvent(new Event("visibilitychange"));
    expect(f.callbacks.size).toBe(0);
    f.doc.hidden = false;
    f.doc.dispatchEvent(new Event("visibilitychange"));
    expect(f.callbacks.size).toBe(1);
    f.controller.dispose();
  });

  it("卸载后释放 GPU/像素/观察器，后续事件不会重新启动动画", () => {
    const f = fixture();
    f.controller.dispose();
    f.controller.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(f.disconnect).toHaveBeenCalledOnce();
    expect(f.artwork.width).toBe(0);
    expect(f.callbacks.size).toBe(0);
    f.doc.dispatchEvent(new Event("visibilitychange"));
    f.controller.setPaused(false);
    expect(f.callbacks.size).toBe(0);
  });

  it("WebGL context 丢失时停止循环并通知回退，不刷新整个登录页", () => {
    const f = fixture();
    const lost = new Event("webglcontextlost", { cancelable: true });
    f.artwork.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(f.failure).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(f.callbacks.size).toBe(0);
  });
});
