"use client";

import { Expand, X } from "lucide-react";
import Image from "next/image";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
    <Dialog>
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
        <DialogTrigger asChild>
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
        </DialogTrigger>
      </div>
      <DialogContent
        aria-describedby={undefined}
        className="block h-[calc(100vh-6rem)] w-[calc(100vw-6rem)] max-w-none border-0 bg-transparent p-0 shadow-none outline-none sm:max-w-none"
        overlayClassName="bg-black/75 backdrop-blur-sm"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{name}</DialogTitle>
        <Image
          src={url}
          alt={name}
          fill
          sizes="100vw"
          className="object-contain"
          unoptimized
          referrerPolicy="no-referrer"
        />
        <DialogClose
          className="absolute right-0 top-0 rounded-full bg-black/65 p-3 text-white transition-colors hover:bg-black focus-visible:outline-2 focus-visible:outline-white"
          aria-label="关闭大图"
        >
          <X className="size-5" aria-hidden="true" />
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
