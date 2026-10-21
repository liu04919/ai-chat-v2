"use client";

import { Pause, Play } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";

import background from "../../../public/auth/companion.png";
import repair from "../../../public/auth/companion-repair.png";
import type { createBackground } from "./background/controller";
import styles from "./auth-background.module.css";

export function AuthBackground() {
  const container = useRef<HTMLDivElement>(null);
  const artwork = useRef<HTMLCanvasElement>(null);
  const particles = useRef<HTMLCanvasElement>(null);
  const controller = useRef<ReturnType<typeof createBackground> | null>(null);
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const host = container.current, art = artwork.current, overlay = particles.current;
    if (!host || !art || !overlay) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let stop = () => { };

    function start() {
      stop();
      // 减少动态效果时不下载大纹理和渲染模块，保留首屏静态图。
      if (reduced.matches) return;
      const abort = new AbortController();
      const bitmaps: ImageBitmap[] = [];
      async function loadTexture(src: string) {
        const response = await fetch(src, { signal: abort.signal, cache: "force-cache" });
        if (!response.ok) throw new Error("背景纹理加载失败");
        const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: "none" });
        if (abort.signal.aborted) {
          bitmap.close();
          abort.signal.throwIfAborted();
        }
        bitmaps.push(bitmap);
        return bitmap;
      }
      async function initialize() {
        try {
          const [{ createBackground }, image, repaired] = await Promise.all([
            import("./background/controller"),
            loadTexture(background.src),
            loadTexture(repair.src),
          ]);
          abort.signal.throwIfAborted();
          controller.current = createBackground({
            container: host!, artwork: art!, particles: overlay!, image, repair: repaired,
            onFailure: () => { controller.current = null; setReady(false); },
          });
          setPaused(false);
          setReady(true);
        } catch {
          const cancelled = abort.signal.aborted;
          abort.abort();
          if (!cancelled) setReady(false);
          // 动画属于装饰：资源或 WebGL 失败不会影响登录，只回退原图。
        } finally {
          bitmaps.forEach(bitmap => bitmap.close());
        }
      }
      const idle = typeof window.requestIdleCallback === "function";
      const task = idle
        ? window.requestIdleCallback(() => void initialize(), { timeout: 1200 })
        : window.setTimeout(() => void initialize(), 100);
      stop = () => {
        abort.abort();
        if (idle) window.cancelIdleCallback(task);
        else window.clearTimeout(task);
        controller.current?.dispose();
        controller.current = null;
      };
    }
    const changeMotion = () => { setReady(false); start(); };
    reduced.addEventListener("change", changeMotion);
    start();
    return () => { reduced.removeEventListener("change", changeMotion); stop(); };
  }, []);

  useEffect(() => { controller.current?.setPaused(paused); }, [paused]);

  return (
    <>
      <div ref={container} className={styles.artwork} aria-hidden="true">
        <Image src={background} alt="" fill sizes="100vw" preload placeholder="blur" className={styles.image} />
        <div className={styles.animation} data-ready={ready}>
          <canvas ref={artwork} />
          <canvas ref={particles} />
        </div>
      </div>
      {ready ? (
        <button type="button" className={styles.toggle} onClick={() => setPaused(value => !value)} aria-label={paused ? "播放背景动画" : "暂停背景动画"} title={paused ? "播放背景动画" : "暂停背景动画"}>
          {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
        </button>
      ) : null}
    </>
  );
}
