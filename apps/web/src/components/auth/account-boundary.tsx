"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";

import { useGenerationProjectionStore } from "@/components/chat/generation/generation-projection-store";
import { watchAccountSession } from "@/lib/account-session";

export function AccountBoundary({
  ownerId,
  children,
}: Readonly<{ ownerId: string; children: React.ReactNode }>) {
  const queryClient = useQueryClient();
  const [invalidated, setInvalidated] = useState(false);

  useEffect(() => {
    function discardAccount() {
      // 先同步卸载受保护页面（包括 Portal 引用弹窗），触发 SSE 的清理。
      // 不能只跳转：新文档加载期间仍可能操作旧页面。
      flushSync(() => setInvalidated(true));
      queryClient.clear();
      useGenerationProjectionStore.setState({ projections: {} });
    }

    return watchAccountSession({
      ownerId,
      onPageHide: discardAccount,
      onInvalidated: () => {
        discardAccount();
        // 不广播，避免标签页相互通知形成循环；服务端决定去聊天页还是登录页。
        window.location.replace("/chat");
      },
    });
  }, [ownerId, queryClient]);

  return invalidated ? null : children;
}
