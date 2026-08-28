import type { MessagePartsDto } from "@ai-chat/contracts";

export function createConversationTitle(parts: MessagePartsDto): string {
  const textPart = parts.find(
    (part) => part.type === "text" && part.text.trim().length > 0,
  );

  if (textPart?.type !== "text") {
    return "附件对话";
  }

  const normalized = textPart.text.trim().replaceAll(/\s+/g, " ");

  return Array.from(normalized).slice(0, 30).join("");
}
