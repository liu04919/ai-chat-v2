/** 只广播认证发生变化，不把账户资料或令牌写入 localStorage。 */
export const accountChangeKey = "ai-chat:account-change";

export function broadcastAccountChange(): void {
  try {
    window.localStorage.setItem(accountChangeKey, crypto.randomUUID());
  } catch {
    // 浏览器禁用存储时，其他标签页仍会在重新聚焦时向服务端核验身份。
  }
}

/** 同步其他标签页的认证变化；服务端会话才是身份依据。 */
export function watchAccountSession({
  ownerId,
  onInvalidated,
  onPageHide,
}: {
  ownerId: string;
  onInvalidated: () => void;
  onPageHide: () => void;
}): () => void {
  let disposed = false;
  let invalidated = false;
  let pending: AbortController | undefined;

  function invalidate() {
    if (disposed || invalidated) return;
    invalidated = true;
    pending?.abort();
    onInvalidated();
  }

  async function verifySession() {
    if (disposed || invalidated) return;
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    try {
      const response = await fetch("/api/auth/get-session?disableCookieCache=true", {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (response.status === 401) {
        invalidate();
        return;
      }
      if (!response.ok) return;
      const session = await response.json();
      if (controller.signal.aborted) return;
      if (
        session === null ||
        (typeof session?.user?.id === "string" && session.user.id !== ownerId)
      ) {
        invalidate();
      }
    } catch {
      // 网络错误不等于退出登录；下次聚焦或恢复网络时重新核验。
    }
  }

  function onStorage(event: StorageEvent) {
    if (event.key === accountChangeKey && event.newValue !== null) invalidate();
  }
  function onVisible() {
    if (document.visibilityState === "visible") void verifySession();
  }
  function onPageShow(event: PageTransitionEvent) {
    // 后退缓存可能保存退出前的整个 React 树，恢复时必须重建文档。
    if (event.persisted) invalidate();
  }
  function suspendPage() {
    pending?.abort();
    onPageHide();
  }

  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", verifySession);
  window.addEventListener("online", verifySession);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("pagehide", suspendPage);
  void verifySession();

  return () => {
    disposed = true;
    pending?.abort();
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("focus", verifySession);
    window.removeEventListener("online", verifySession);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("pagehide", suspendPage);
  };
}
