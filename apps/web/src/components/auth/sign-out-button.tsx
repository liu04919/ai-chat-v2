"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { navigateAfterAuthentication } from "@/lib/auth-navigation";

export function SignOutButton() {
  const [error, setError] = useState<string>();
  const [isPending, startTransition] = useTransition();

  function signOut() {
    setError(undefined);
    startTransition(async () => {
      try {
        const result = await authClient.signOut();

        if (result.error) {
          setError("退出失败，请重试");
          return;
        }

        navigateAfterAuthentication("/login");
      } catch {
        setError("退出失败，请重试");
      }
    });
  }

  return (
    <div className="flex items-center gap-3">
      {error ? (
        <span className="text-sm text-red-600" role="alert">
          {error}
        </span>
      ) : null}
      <Button disabled={isPending} onClick={signOut} size="sm" variant="outline">
        {isPending ? "正在退出…" : "退出登录"}
      </Button>
    </div>
  );
}
