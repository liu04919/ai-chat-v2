"use client";

import { useEffect } from "react";

import { navigateAfterAuthentication } from "@/lib/auth/navigation";

/** OAuth 回调已设置 Cookie；沿用邮箱登录的跨标签页通知和整页跳转。 */
export default function AuthenticationCompletePage() {
  useEffect(() => navigateAfterAuthentication("/chat"), []);

  return (
    <main className="grid min-h-svh place-items-center">
      <p className="text-sm text-muted-foreground" role="status">
        正在进入你的对话空间…
      </p>
    </main>
  );
}
