import type {
  ConversationShareAttachmentDto,
  ConversationShareSnapshotDto,
  MessageDto,
} from "@ai-chat/contracts";
import { Brain, FileText, Wrench } from "lucide-react";
import Image from "next/image";

import { ShareMessageMarkdown } from "./share-message-markdown";

function attachmentUrl(token: string, attachmentId: string) {
  return `/api/shares/${encodeURIComponent(token)}/attachments/${encodeURIComponent(attachmentId)}`;
}

function SharedAttachment({
  attachment,
  token,
}: Readonly<{
  attachment: ConversationShareAttachmentDto;
  token: string;
}>) {
  const url = attachmentUrl(token, attachment.id);

  if (attachment.mediaType.startsWith("image/")) {
    return (
      <Image
        alt={attachment.originalName}
        className="h-auto max-h-[42rem] w-auto max-w-full rounded-2xl border bg-muted/40 object-contain"
        height={800}
        loading="lazy"
        src={url}
        unoptimized
        width={1200}
      />
    );
  }

  return (
    <a
      className="flex w-fit max-w-full items-center gap-3 rounded-xl border bg-background px-4 py-3 transition-colors hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-ring"
      href={url}
      rel="noopener noreferrer"
      target="_blank"
    >
      <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block truncate font-medium">{attachment.originalName}</span>
        <span className="block text-xs text-muted-foreground">
          PDF · {Math.max(1, Math.round(attachment.sizeBytes / 1024))} KiB
        </span>
      </span>
    </a>
  );
}

function SharedMessage({
  attachments,
  message,
  token,
}: Readonly<{
  attachments: ReadonlyMap<string, ConversationShareAttachmentDto>;
  message: MessageDto;
  token: string;
}>) {
  const content = message.parts.map((part, index) => {
    switch (part.type) {
      case "text":
        return (
          <ShareMessageMarkdown
            key={"id" in part ? part.id : `text-${index}`}
            text={part.text}
          />
        );
      case "reasoning":
        return (
          <details className="mb-3 text-muted-foreground" key={part.id}>
            <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium">
              <Brain className="size-4" aria-hidden="true" />
              思考过程
            </summary>
            <div className="mt-2 border-l pl-4 text-sm leading-6">
              <ShareMessageMarkdown text={part.text} />
            </div>
          </details>
        );
      case "attachment": {
        const attachment = attachments.get(part.attachmentId);
        return attachment ? (
          <div className="mt-2" key={"id" in part ? part.id : part.attachmentId}>
            <SharedAttachment attachment={attachment} token={token} />
          </div>
        ) : null;
      }
      case "tool-call":
        return (
          <div className="my-2 flex w-fit items-center gap-2 rounded-xl border bg-muted/50 px-3 py-2 text-xs text-muted-foreground" key={part.id}>
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

  return message.role === "user" ? (
    <article className="flex justify-end">
      <div className="max-w-[85%] space-y-2 rounded-3xl bg-muted px-5 py-3.5 text-sm leading-7 sm:max-w-[75%]">
        {content}
      </div>
    </article>
  ) : (
    <article className="min-w-0 space-y-3 text-sm leading-7 sm:text-base sm:leading-8">
      {content}
    </article>
  );
}

export function ShareConversation({
  snapshot,
  token,
}: Readonly<{
  snapshot: ConversationShareSnapshotDto;
  token: string;
}>) {
  const attachments = new Map(
    snapshot.attachments.map((attachment) => [attachment.id, attachment]),
  );

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-9">
      {snapshot.messages.map((message) => (
        <SharedMessage
          attachments={attachments}
          key={message.id}
          message={message}
          token={token}
        />
      ))}
    </section>
  );
}
