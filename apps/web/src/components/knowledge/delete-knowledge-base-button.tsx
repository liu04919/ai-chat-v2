"use client";

import type { KnowledgeBaseDto } from "@ai-chat/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
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
import { removeKnowledgeBase } from "@/lib/knowledge-client";
import { useKnowledgeBases } from "./knowledge-provider";

export function DeleteKnowledgeBaseButton({
  base,
  onDeleted,
}: Readonly<{
  base: KnowledgeBaseDto;
  onDeleted: (cleanupFailed: boolean) => void;
}>) {
  const [confirming, setConfirming] = useState(false);
  const catalog = useKnowledgeBases();
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: () => removeKnowledgeBase(base.id),
    onSuccess: async (result) => {
      const documentsKey = ["knowledge-documents", catalog.ownerId, base.id];
      // 取消旧请求，防止删除前的响应把刚移除的知识库写回缓存。
      await Promise.all([
        client.cancelQueries({ queryKey: catalog.queryKey }),
        client.cancelQueries({ queryKey: documentsKey }),
      ]);
      client.setQueryData<KnowledgeBaseDto[]>(catalog.queryKey, (bases) =>
        (bases ?? []).filter((item) => item.id !== base.id),
      );
      client.removeQueries({ queryKey: documentsKey });
      setConfirming(false);
      onDeleted(result.cleanupFailed);
      void client.invalidateQueries({ queryKey: catalog.queryKey });
    },
  });
  return (
    <>
      <Button
        variant="ghost"
        aria-label={`删除知识库 ${base.name}`}
        title="删除知识库"
        className="pointer-events-none size-8 shrink-0 cursor-pointer rounded-lg p-0 text-destructive opacity-0 group-hover/knowledge-base:pointer-events-auto group-hover/knowledge-base:opacity-100 hover:bg-destructive/10 hover:text-destructive focus-visible:pointer-events-auto focus-visible:opacity-100"
        onClick={() => {
          remove.reset();
          setConfirming(true);
        }}
      >
        <Trash2 className="size-4" />
      </Button>
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!remove.isPending) setConfirming(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除知识库？</DialogTitle>
            <DialogDescription>
              “{base.name}
              ”及其中所有文件将被永久删除。已有回答和分享中的引用会保留。
            </DialogDescription>
          </DialogHeader>
          {remove.error ? (
            <p role="alert" className="text-sm text-destructive">
              {remove.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={remove.isPending}
              onClick={() => setConfirming(false)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? "删除中…" : "删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
