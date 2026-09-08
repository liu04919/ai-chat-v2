import type {
  AssistantMessageViewPartsDto,
  UserMessagePartsDto,
} from "@ai-chat/contracts";

import { MessageAttachment } from "./message-attachment";
import { MessageMarkdown } from "./message-markdown";
import { KnowledgeSources } from "@/components/knowledge/knowledge-sources";
import { splitMessageDisplay } from "./message-display";
import { MessageProcess } from "./message-process";

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
  const sources = parts.flatMap((p) => p.type === "knowledge-sources" ? p.sources : []);
  const { processParts, contentParts } = splitMessageDisplay(parts);
  const content = contentParts.map((part, index) => {
    switch (part.type) {
      case "knowledge-sources":
        return <KnowledgeSources key={part.id} sources={part.sources} />;
      case "text":
        return (
          <MessageMarkdown
            key={"id" in part ? part.id : `text-${index}`}
            text={part.text}
            sources={sources}
          />
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
    }
  });
  return (
    <>
      <MessageProcess
        parts={processParts}
        isStreaming={isStreaming}
        expandedReasoningIds={expandedReasoningIds}
        onReasoningToggle={onReasoningToggle}
        renderReasoning={(text) => <MessageMarkdown text={text} />}
      />
      {content}
    </>
  );
}
