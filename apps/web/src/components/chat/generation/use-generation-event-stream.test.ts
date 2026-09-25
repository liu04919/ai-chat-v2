import type { GenerationEventDto } from "@ai-chat/contracts";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGenerationEventStream } from "./use-generation-event-stream";
import { useGenerationProjectionStore } from "./generation-projection-store";

// 显式运行 effect 的建立/清理；EventSource 和 rAF 可控，不连接模型或浏览器服务。
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: vi.fn(),
  useEffectEvent: (callback: unknown) => callback,
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  emit(event: GenerationEventDto, cursor: string) {
    this.onmessage?.({ data: JSON.stringify(event), lastEventId: cursor });
  }
}

let frames: Map<number, () => void>;
let nextFrame: number;
let cleanups: Array<() => void>;
const store = () => useGenerationProjectionStore.getState();
const projection = () => store().projections.c1;
const delta = (text: string, id = "g1"): GenerationEventDto => ({
  type: "text.delta", generationId: id, partId: "text", delta: text,
});
const currentSource = () => FakeEventSource.instances.at(-1)!;
function flushFrames() {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach((callback) => callback());
}
function mount(options: Partial<Parameters<typeof useGenerationEventStream>[0]> = {}) {
  const onTerminal = vi.fn();
  // eslint-disable-next-line react-hooks/rules-of-hooks -- 测试中 effect 已替换为可手动建立/清理的函数。
  useGenerationEventStream({ conversationId: "c1", generationId: "g1", enabled: true, onTerminal, ...options });
  const cleanup = vi.mocked(useEffect).mock.calls.at(-1)![0]() ?? (() => {});
  cleanups.push(cleanup);
  return { cleanup, onTerminal };
}

beforeEach(() => {
  vi.clearAllMocks();
  useGenerationProjectionStore.setState({ projections: {} });
  FakeEventSource.instances = [];
  frames = new Map();
  nextFrame = 0;
  cleanups = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("window", {
    requestAnimationFrame(callback: () => void) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(handle: number) { frames.delete(handle); },
  });
});
afterEach(() => {
  cleanups.forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});

describe("切换会话时的 SSE 生命周期", () => {
  it.each([null, "g1"])("最新详情未同步前不使用旧 activeGeneration=%s 连接或清缓存", (generationId) => {
    store().start("c1", "g1");
    store().apply("c1", "g1", [{ cursor: "100-0", event: delta("保留") }]);
    const before = projection();
    mount({ enabled: false, generationId });
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(projection()).toBe(before);
  });

  it("切走丢弃未合并帧，回来从已应用游标续传，不缺字、不重复", () => {
    const first = mount();
    const source = currentSource();
    source.emit(delta("你"), "100-0");
    expect(projection()?.lastEventId).toBeNull();
    flushFrames();
    source.emit(delta("好"), "100-1");
    first.cleanup();
    expect(source.close).toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(projection()).toMatchObject({ lastEventId: "100-0", parts: [{ text: "你" }] });

    mount();
    const resumed = currentSource();
    expect(resumed.url).toBe("/api/generations/g1/events?after=100-0");
    source.emit(delta("已卸载连接的迟到事件"), "100-2");
    source.onerror?.();
    resumed.emit(delta("你"), "100-0");
    resumed.emit(delta("好"), "100-1");
    flushFrames();
    expect(projection()).toMatchObject({ status: "running", lastEventId: "100-1", parts: [{ text: "你好" }] });
  });

  it("同一个连接自动重连保留内容，浏览器负责 Last-Event-ID", () => {
    mount();
    const source = currentSource();
    source.emit(delta("你"), "100-0");
    source.onerror?.();
    source.onopen?.();
    source.emit(delta("好"), "100-1");
    flushFrames();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(projection()).toMatchObject({ lastEventId: "100-1", parts: [{ text: "你好" }] });
  });

  it("最新详情没有活跃任务时清理旧快照，不再打开 SSE", () => {
    store().start("c1", "g1");
    store().apply("c1", "g1", [{ cursor: "100-0", event: delta("旧内容") }]);
    mount({ generationId: null });
    expect(projection()).toBeUndefined();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("最新详情已是新任务时从头开始，旧连接回调不能修改新快照", () => {
    const first = mount();
    const old = currentSource();
    old.emit(delta("旧内容"), "100-0");
    flushFrames();
    first.cleanup();
    mount({ generationId: "g2" });
    expect(currentSource().url).toBe("/api/generations/g2/events");
    old.onerror?.();
    old.onopen?.();
    old.emit(delta("迟到"), "100-1");
    flushFrames();
    expect(projection()).toMatchObject({ generationId: "g2", lastEventId: null, parts: [], status: "connecting" });
  });

  it.each(["completed", "failed", "cancelled"] as const)("%s 立即提交最后一批内容与游标，再同步历史", (status) => {
    const { onTerminal } = mount();
    const source = currentSource();
    source.emit(delta("最后内容"), "100-0");
    source.emit({ type: `generation.${status}`, generationId: "g1" }, "100-1");
    expect(frames.size).toBe(0);
    expect(projection()).toMatchObject({ status, lastEventId: "100-1", parts: [{ text: "最后内容" }] });
    expect(onTerminal).toHaveBeenCalledExactlyOnceWith({ type: `generation.${status}`, generationId: "g1" });
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("缓存已是终态但历史未接管时，只重试对账，不从终态游标后空等", () => {
    store().start("c1", "g1");
    store().apply("c1", "g1", [{ cursor: "100-0", event: { type: "generation.completed", generationId: "g1" } }]);
    const { onTerminal } = mount();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(onTerminal).toHaveBeenCalledWith({ type: "generation.completed", generationId: "g1" });
  });

  it("缺少合法事件 ID 时停止连接，不产生无法安全续传的快照", () => {
    mount();
    currentSource().emit(delta("不能应用"), "");
    flushFrames();
    expect(projection()).toMatchObject({ status: "connection-error", lastEventId: null, parts: [] });
    expect(currentSource().close).toHaveBeenCalledOnce();
  });
});
