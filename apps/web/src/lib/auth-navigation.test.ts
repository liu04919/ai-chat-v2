import { afterEach, describe, expect, it, vi } from "vitest";

import { navigateAfterAuthentication } from "./auth-navigation";

afterEach(() => vi.unstubAllGlobals());

describe("认证后的文档边界", () => {
  it.each(["/login", "/chat"] as const)("跳转 %s 必须更换文档而非复用客户端缓存", (path) => {
    const replace = vi.fn();
    vi.stubGlobal("window", { location: { replace } });

    navigateAfterAuthentication(path);

    expect(replace).toHaveBeenCalledExactlyOnceWith(path);
  });
});
