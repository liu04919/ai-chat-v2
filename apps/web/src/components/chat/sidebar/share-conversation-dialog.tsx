"use client";

import type { ConversationSummaryDto } from "@ai-chat/contracts";
import { Check, Copy, LoaderCircle } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import { useConversationShare } from "./use-conversation-share";

export function ShareConversationDialog({
  conversation,
  open,
  onOpenChange,
}: Readonly<{
  conversation: ConversationSummaryDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>) {
  const conversationId = conversation?.id ?? "";
  const { query, createMutation, deleteMutation } = useConversationShare(
    conversationId,
    open,
  );
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const share = query.data?.share ?? null;
  const mutationError = createMutation.error ?? deleteMutation.error;
  const busy = createMutation.isPending || deleteMutation.isPending;

  async function copyLink() {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) {
          setCopyStatus("idle");
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>分享对话</DialogTitle>
          <DialogDescription>
            任何获得链接的人都可以查看。
          </DialogDescription>
        </DialogHeader>

        {query.isPending ? (
          <div className="flex h-24 items-center justify-center text-muted-foreground" role="status">
            <LoaderCircle className="mr-2 size-4 motion-safe:animate-spin" aria-hidden="true" />
            正在读取…
          </div>
        ) : query.isError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
            <p>无法读取分享状态</p>
            <Button className="mt-3" onClick={() => void query.refetch()} size="sm" variant="outline">
              重试
            </Button>
          </div>
        ) : share ? (
          <div className="flex gap-2">
            <Input aria-label="分享链接" readOnly value={share.url} />
            <Button className="shrink-0 gap-2" onClick={() => void copyLink()} variant="outline">
              {copyStatus === "copied" ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
              {copyStatus === "copied" ? "已复制" : copyStatus === "failed" ? "复制失败" : "复制"}
            </Button>
          </div>
        ) : null}

        {mutationError ? (
          <p className="text-sm text-destructive" role="alert">
            {mutationError.message}
          </p>
        ) : null}

        {!query.isPending && !query.isError ? (
          <DialogFooter>
            {share ? (
              <Button disabled={busy} onClick={() => deleteMutation.mutate()} variant="destructive">
                {deleteMutation.isPending ? "正在停止…" : "停止分享"}
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => createMutation.mutate()}>
                {createMutation.isPending ? "正在创建…" : "创建链接"}
              </Button>
            )}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
