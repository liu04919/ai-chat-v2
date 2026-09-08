import type {
  AssistantMessageViewPartsDto,
  UserMessagePartsDto,
} from "@ai-chat/contracts";

type MessagePart = (AssistantMessageViewPartsDto | UserMessagePartsDto)[number];
export type ProcessPart = Extract<MessagePart, {
  type: "reasoning" | "tool-call" | "tool-result";
}>;

// 只整理展示：原始 Parts 的顺序仍供落库、流重放与模型历史使用。
export function splitMessageDisplay(parts: readonly MessagePart[]) {
  const processParts: ProcessPart[] = [];
  const contentParts: Exclude<MessagePart, ProcessPart>[] = [];
  for (const part of parts) {
    switch (part.type) {
      case "reasoning":
      case "tool-call":
      case "tool-result":
        processParts.push(part);
        break;
      default:
        contentParts.push(part);
    }
  }
  return { processParts, contentParts };
}
