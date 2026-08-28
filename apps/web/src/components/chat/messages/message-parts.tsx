import type { MessagePartsDto } from "@ai-chat/contracts";
import { Paperclip } from "lucide-react";

export function MessageParts({ parts }: Readonly<{ parts: MessagePartsDto }>) {
  return parts.map((part, index) =>
    part.type === "text" ? (
      <p className="whitespace-pre-wrap" key={`text-${index}`}>
        {part.text}
      </p>
    ) : (
      <div
        className="mt-2 flex w-fit items-center gap-2 rounded-xl border bg-background px-3 py-2 text-muted-foreground"
        key={part.attachmentId}
      >
        <Paperclip className="size-4" aria-hidden="true" />
        <span>附件</span>
      </div>
    ),
  );
}
