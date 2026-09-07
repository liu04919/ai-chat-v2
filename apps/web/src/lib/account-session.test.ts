import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { accountChangeKey, broadcastAccountChange, watchAccountSession } from "./account-session";

let target: EventTarget;
let documentTarget: EventTarget & { visibilityState: string };
let fetchSession: ReturnType<typeof vi.fn>;
let cleanup: (() => void) | undefined;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const response = (id: string | null) => Response.json(id ? { user: { id } } : null);

function storageEvent(key: string, newValue: string | null = "changed") {
  const event = new Event("storage");
  Object.assign(event, { key, newValue });
  return event;
}

beforeEach(() => {
  target = new EventTarget();
  documentTarget = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", target);
  vi.stubGlobal("document", documentTarget);
  fetchSession = vi.fn().mockImplementation(async () => response("owner-a"));
  vi.stubGlobal("fetch", fetchSession);
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
});

function watch() {
  const onInvalidated = vi.fn();
  const onPageHide = vi.fn();
  cleanup = watchAccountSession({ ownerId: "owner-a", onInvalidated, onPageHide });
  return { onInvalidated, onPageHide };
}

describe("跨标签页账户边界", () => {
  it("广播只有随机标记；存储被禁用也不阻止本页退出", () => {
    const setItem = vi.fn();
    Object.assign(target, { localStorage: { setItem } });
    broadcastAccountChange();
    broadcastAccountChange();
    expect(setItem.mock.calls[0][0]).toBe(accountChangeKey);
    expect(setItem.mock.calls[0][1]).not.toBe(setItem.mock.calls[1][1]);
    setItem.mockImplementation(() => { throw new Error("disabled"); });
    expect(broadcastAccountChange).not.toThrow();
  });

  it("认证通知立即失效一次，不等待会话请求；无关存储变化不影响页面", () => {
    fetchSession.mockImplementation(() => new Promise(() => {}));
    const { onInvalidated } = watch();
    target.dispatchEvent(storageEvent("other"));
    target.dispatchEvent(storageEvent(accountChangeKey, null));
    expect(onInvalidated).not.toHaveBeenCalled();
    target.dispatchEvent(storageEvent(accountChangeKey));
    target.dispatchEvent(storageEvent(accountChangeKey));
    expect(onInvalidated).toHaveBeenCalledTimes(1);
    expect(fetchSession.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("同一账户不会重载，核验不使用 HTTP 或会话 cookie 缓存", async () => {
    const { onInvalidated } = watch();
    await settle();
    expect(onInvalidated).not.toHaveBeenCalled();
    expect(fetchSession).toHaveBeenCalledWith("/api/auth/get-session?disableCookieCache=true", expect.objectContaining({ cache: "no-store", credentials: "same-origin" }));
  });

  it.each(["owner-b", null])("挂载时发现会话变为 %s，丢弃服务端旧页面", async (id) => {
    fetchSession.mockResolvedValue(response(id));
    const { onInvalidated } = watch();
    await settle();
    expect(onInvalidated).toHaveBeenCalledTimes(1);
  });

  it.each(["focus", "online", "visibilitychange"])("遗漏广播后通过 %s 检测换号", async (event) => {
    const { onInvalidated } = watch();
    await settle();
    fetchSession.mockResolvedValue(response("owner-b"));
    (event === "visibilitychange" ? documentTarget : target).dispatchEvent(new Event(event));
    await settle();
    expect(onInvalidated).toHaveBeenCalledTimes(1);
  });

  it("401 失效；网络错误和 500 不冒充退出登录", async () => {
    fetchSession.mockRejectedValueOnce(new Error("offline"));
    const { onInvalidated } = watch();
    await settle();
    fetchSession.mockResolvedValueOnce(new Response(null, { status: 500 }));
    target.dispatchEvent(new Event("focus"));
    await settle();
    expect(onInvalidated).not.toHaveBeenCalled();
    fetchSession.mockResolvedValueOnce(new Response(null, { status: 401 }));
    target.dispatchEvent(new Event("focus"));
    await settle();
    expect(onInvalidated).toHaveBeenCalledTimes(1);
  });

  it("较早的会话响应不能覆盖较新的核验结果", async () => {
    let resolveOld!: (value: Response) => void;
    fetchSession.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }));
    const { onInvalidated } = watch();
    target.dispatchEvent(new Event("focus"));
    await settle();
    resolveOld(response("owner-b"));
    await settle();
    expect(onInvalidated).not.toHaveBeenCalled();
  });

  it("离开页面先移除敏感内容；后退缓存恢复时重建文档", () => {
    const { onInvalidated, onPageHide } = watch();
    target.dispatchEvent(new Event("pagehide"));
    expect(onPageHide).toHaveBeenCalledTimes(1);
    target.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    expect(onInvalidated).not.toHaveBeenCalled();
    target.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(onInvalidated).toHaveBeenCalledTimes(1);
  });

  it("卸载会取消请求和所有监听，不处理迟到的响应", async () => {
    let finish!: (value: Response) => void;
    fetchSession.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const { onInvalidated, onPageHide } = watch();
    cleanup?.();
    expect(fetchSession.mock.calls[0][1].signal.aborted).toBe(true);
    finish(response(null));
    target.dispatchEvent(storageEvent(accountChangeKey));
    target.dispatchEvent(new Event("focus"));
    target.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(fetchSession).toHaveBeenCalledTimes(1);
    expect(onInvalidated).not.toHaveBeenCalled();
    expect(onPageHide).not.toHaveBeenCalled();
  });
});
