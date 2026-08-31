"use client";

import { Expand, X } from "lucide-react";
import Image from "next/image";
import { Dialog } from "radix-ui";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ImagePlaceholder } from "./image-placeholder";

export function AttachmentImage({
  url,
  name,
  retry,
  isRetrying,
}: Readonly<{
  url: string;
  name: string;
  retry: () => void;
  isRetrying: boolean;
}>) {
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">(
    "loading",
  );
  const [imageSize, setImageSize] = useState({ width: 480, height: 320 });
  if (loadState === "error") {
    return (
      <div className="flex aspect-3/2 w-[480px] max-w-full flex-col items-center justify-center gap-3 rounded-2xl border bg-muted/50">
        <p className="text-sm text-muted-foreground" role="alert">
          图片加载失败
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={isRetrying}
          onClick={retry}
        >
          重新加载
        </Button>
      </div>
    );
  }
  return (
    <Dialog.Root>
      <div
        className="relative max-w-full overflow-hidden rounded-2xl border bg-muted/40"
        style={{
          width: Math.min(
            480,
            imageSize.width,
            (480 * imageSize.width) / imageSize.height,
          ),
        }}
      >
        {loadState === "loading" ? (
          <div className="absolute inset-0">
            <ImagePlaceholder label="正在加载图片…" />
          </div>
        ) : null}
        <Dialog.Trigger asChild>
          <button
            type="button"
            aria-label={`查看大图：${name}`}
            disabled={loadState !== "loaded"}
            className="group relative block w-full cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
            style={{ aspectRatio: `${imageSize.width} / ${imageSize.height}` }}
          >
            <Image
              src={url}
              alt={name}
              fill
              sizes="480px"
              unoptimized
              referrerPolicy="no-referrer"
              className={`object-contain transition-opacity duration-300 motion-reduce:transition-none ${loadState === "loaded" ? "opacity-100" : "opacity-0"}`}
              onLoad={(event) => {
                const image = event.currentTarget;
                setImageSize({
                  width: image.naturalWidth,
                  height: image.naturalHeight,
                });
                setLoadState("loaded");
              }}
              onError={() => setLoadState("error")}
            />
            {loadState === "loaded" ? (
              <span className="absolute right-3 top-3 rounded-full bg-black/60 p-2 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <Expand className="size-4" aria-hidden="true" />
              </span>
            ) : null}
          </button>
        </Dialog.Trigger>
      </div>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 h-[calc(100vh-6rem)] w-[calc(100vw-6rem)] -translate-x-1/2 -translate-y-1/2 outline-none"
        >
          <Dialog.Title className="sr-only">{name}</Dialog.Title>
          <Image
            src={url}
            alt={name}
            fill
            sizes="100vw"
            className="object-contain"
            unoptimized
            referrerPolicy="no-referrer"
          />
          <Dialog.Close
            className="absolute right-0 top-0 rounded-full bg-black/65 p-3 text-white transition-colors hover:bg-black focus-visible:outline-2 focus-visible:outline-white"
            aria-label="关闭大图"
          >
            <X className="size-5" aria-hidden="true" />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
