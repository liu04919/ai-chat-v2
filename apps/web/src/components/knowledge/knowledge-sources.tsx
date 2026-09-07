"use client";

import type { KnowledgeSourceDto } from "@ai-chat/contracts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function KnowledgeCitation({
  source,
  compact = false,
}: Readonly<{ source: KnowledgeSourceDto; compact?: boolean }>) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={`查看引用 ${source.number}：${source.originalName}`}
          className={
            compact
              ? "mx-0.5 inline-flex cursor-pointer rounded bg-primary/10 px-1.5 text-xs font-medium text-primary hover:bg-primary/20"
              : "max-w-full cursor-pointer truncate rounded-lg border px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted"
          }
        >
          [{source.number}]
          {compact ? null : ` ${source.originalName} · 第 ${source.page} 页`}
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="break-words pr-5">
            {source.originalName}
          </DialogTitle>
          <DialogDescription>
            引用 [{source.number}] · 第 {source.page} 页 · 当次检索片段
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words text-sm leading-7">
          {source.content}
        </div>
      </DialogContent>
    </Dialog>
  );
}
export function KnowledgeSources({
  sources,
}: Readonly<{ sources: readonly KnowledgeSourceDto[] }>) {
  if (!sources.length) return null;
  return (
    <details className="my-3 text-sm">
      <summary className="cursor-pointer text-xs text-muted-foreground">
        参考资料 · {sources.length}
      </summary>
      <div className="mt-2 flex flex-wrap gap-2">
        {sources.map((source) => (
          <KnowledgeCitation key={source.number} source={source} />
        ))}
      </div>
    </details>
  );
}
