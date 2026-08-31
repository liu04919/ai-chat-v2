"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText, LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getAttachmentClientErrorMessage } from "../../../lib/attachments-client";
import { AttachmentImage } from "./attachment-image";
import { attachmentQueryOptions } from "./attachment-query";
import { ImagePlaceholder } from "./image-placeholder";

export function MessageAttachment({
  attachmentId,
  imagePlaceholder = false,
}: Readonly<{
  attachmentId: string;
  imagePlaceholder?: boolean;
}>) {
  const query = useQuery(attachmentQueryOptions(attachmentId));
  const reload = () => {
    void query.refetch();
  };
  if (query.isPending) {
    return imagePlaceholder ? (
      <ImagePlaceholder label="正在加载图片…" />
    ) : (
      <div
        className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm text-muted-foreground"
        role="status"
      >
        <LoaderCircle
          className="size-4 motion-safe:animate-spin"
          aria-hidden="true"
        />
        正在加载附件…
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="rounded-xl border p-3 text-sm">
        <p className="text-destructive" role="alert">
          {getAttachmentClientErrorMessage(query.error)}
        </p>
        <Button
          className="mt-2"
          variant="outline"
          size="sm"
          onClick={reload}
          disabled={query.isFetching}
        >
          重新加载
        </Button>
      </div>
    );
  }
  const { attachment, download } = query.data;
  if (attachment.mediaType.startsWith("image/")) {
    return (
      <AttachmentImage
        key={query.dataUpdatedAt}
        url={download.url}
        name={attachment.originalName}
        retry={reload}
        isRetrying={query.isFetching}
      />
    );
  }
  return (
    <a
      className="flex w-fit max-w-full items-center gap-3 rounded-xl border bg-background px-4 py-3 transition-colors hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-ring"
      href={`/api/attachments/${encodeURIComponent(attachmentId)}/content`}
      target="_blank"
      rel="noopener noreferrer"
    >
      <FileText
        className="size-5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="min-w-0">
        <span className="block truncate font-medium">
          {attachment.originalName}
        </span>
        <span className="block text-xs text-muted-foreground">
          PDF · {Math.max(1, Math.round(attachment.sizeBytes / 1024))} KiB
        </span>
      </span>
    </a>
  );
}
