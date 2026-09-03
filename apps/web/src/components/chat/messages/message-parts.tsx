import type {
  AssistantMessageViewPartsDto,
  UserMessagePartsDto,
} from "@ai-chat/contracts";
import { Brain, Wrench } from "lucide-react";

import { MessageAttachment } from "./message-attachment";
import { MessageMarkdown } from "./message-markdown";

type MessagePartsDto = UserMessagePartsDto | AssistantMessageViewPartsDto;

export function MessageParts({
  isStreaming = false,
  imageAttachments = false,
  parts,
  expandedReasoningIds,
  onReasoningToggle,
}: Readonly<{
  isStreaming?: boolean;
  imageAttachments?: boolean;
  parts: MessagePartsDto;
  expandedReasoningIds?: ReadonlySet<string>;
  onReasoningToggle?: (partId: string, open: boolean) => void;
}>) {
  return parts.map((part, index) => {
    switch (part.type) {
      case "text":
        return (
          <MessageMarkdown
            key={"id" in part ? part.id : `text-${index}`}
            text={part.text}
          />
        );
      case "reasoning":
        return (
          <details
            className="mb-3 text-muted-foreground"
            open={isStreaming || expandedReasoningIds?.has(part.id) || undefined}
            onToggle={onReasoningToggle
              ? (event) => onReasoningToggle(part.id, event.currentTarget.open)
              : undefined}
            key={part.id}
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium">
              <Brain className="size-4" aria-hidden="true" />
              思考过程
            </summary>
            <div className="mt-2 border-l pl-4 text-sm leading-6">
              <MessageMarkdown text={part.text} />
            </div>
          </details>
        );
      case "attachment":
        return (
          <div
            className="mt-2"
            key={"id" in part ? part.id : part.attachmentId}
          >
            <MessageAttachment
              attachmentId={part.attachmentId}
              imagePlaceholder={imageAttachments}
            />
          </div>
        );
      case "tool-call":
        return (
          <div
            className="my-2 flex w-fit items-center gap-2 rounded-xl border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
            key={part.id}
          >
            <Wrench className="size-4" aria-hidden="true" />
            <span>{part.toolName}</span>
          </div>
        );
      case "tool-result":
        return (
          <p className="my-2 text-xs text-muted-foreground" key={part.id}>
            {part.isError ? "工具执行失败" : "工具执行完成"}
          </p>
        );
    }
  });
}
