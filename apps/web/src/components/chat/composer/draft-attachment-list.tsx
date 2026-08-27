"use client";

import {
  Check,
  FileText,
  LoaderCircle,
  RotateCcw,
  X,
} from "lucide-react";
import Image from "next/image";

import { Button } from "@/components/ui/button";

import type { DraftAttachmentItem } from "./use-draft-attachments";

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(sizeBytes / 1024))} KiB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function AttachmentStatus({ item }: Readonly<{ item: DraftAttachmentItem }>) {
  if (item.status === "uploading") {
    return (
      <span className="flex items-center gap-1 text-muted-foreground">
        <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
        上传中
      </span>
    );
  }

  if (item.status === "removing") {
    return (
      <span className="flex items-center gap-1 text-muted-foreground">
        <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
        正在移除
      </span>
    );
  }

  if (item.status === "ready") {
    return (
      <span className="flex items-center gap-1 text-emerald-700">
        <Check className="size-3" aria-hidden="true" />
        已上传
      </span>
    );
  }

  return <span className="text-destructive">{item.error}</span>;
}

export function DraftAttachmentList({
  items,
  onRemove,
  onRetry,
}: Readonly<{
  items: DraftAttachmentItem[];
  onRemove: (item: DraftAttachmentItem) => void;
  onRetry: (item: DraftAttachmentItem) => void;
}>) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div
      aria-label="草稿附件"
      className="flex gap-2 overflow-x-auto px-2 pt-2"
    >
      {items.map((item) => (
        <article
          className="flex w-64 shrink-0 items-center gap-3 rounded-xl border bg-card p-2 shadow-sm"
          key={item.localId}
        >
          <div className="relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
            {item.previewUrl ? (
              <Image
                alt=""
                className="object-cover"
                fill
                sizes="48px"
                src={item.previewUrl}
                unoptimized
              />
            ) : (
              <FileText
                className="size-5 text-muted-foreground"
                aria-hidden="true"
              />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium" title={item.file.name}>
              {item.file.name}
            </p>
            <div
              aria-live="polite"
              className="mt-1 flex items-center gap-2 text-xs"
            >
              <span className="text-muted-foreground">
                {formatFileSize(item.file.size)}
              </span>
              <AttachmentStatus item={item} />
            </div>
          </div>

          <div className="flex shrink-0 items-center">
            {item.status === "error" ? (
              <Button
                aria-label={`重新上传 ${item.file.name}`}
                className="size-8 rounded-full p-0"
                onClick={() => onRetry(item)}
                title="重新上传"
                variant="ghost"
              >
                <RotateCcw className="size-4" aria-hidden="true" />
              </Button>
            ) : null}
            <Button
              aria-label={`移除 ${item.file.name}`}
              className="size-8 rounded-full p-0"
              disabled={item.status === "uploading" || item.status === "removing"}
              onClick={() => onRemove(item)}
              title="移除附件"
              variant="ghost"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </article>
      ))}
    </div>
  );
}
