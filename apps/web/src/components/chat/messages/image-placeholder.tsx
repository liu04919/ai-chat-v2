import { ImageIcon } from "lucide-react";

export function ImagePlaceholder({ label }: Readonly<{ label: string }>) {
  return (
    <div
      className="relative aspect-[3/2] w-[480px] max-w-full overflow-hidden rounded-2xl border bg-muted"
      data-image-skeleton
    >
      <div
        className="absolute inset-0 bg-gradient-to-br from-foreground/5 via-background/80 to-foreground/10 motion-safe:animate-pulse"
        aria-hidden="true"
      />
      <div
        className="relative flex h-full flex-col items-center justify-center gap-3 text-muted-foreground"
        role="status"
      >
        <ImageIcon className="size-8 opacity-60" aria-hidden="true" />
        <span className="text-sm">{label}</span>
      </div>
    </div>
  );
}
