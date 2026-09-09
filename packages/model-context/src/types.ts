import type { AssistantMessagePartsDto } from "@ai-chat/contracts";

export type ChatModelUserPart =
  | { type: "text"; text: string }
  | { type: "file"; url: string; mediaType: string; filename?: string };

export type ChatModelMessage =
  | { role: "user"; parts: ChatModelUserPart[] }
  | { role: "assistant"; parts: AssistantMessagePartsDto };

/** 只计算回放投影的文本/协议部分，附件内容单独计数，不能拿原始 parts JSON 代替。 */
export type MessageTokenCount = { version: string; textTokens: number };

export type AttachmentTokenCount = {
  version: string;
  etag: string | null;
  tokens: number;
} & (
  | { kind: "image"; width: number; height: number }
  | { kind: "pdf"; pages: number; textTokens: number }
);
