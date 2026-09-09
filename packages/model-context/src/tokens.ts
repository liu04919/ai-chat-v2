import type {
  AssistantMessagePartsDto,
  UserMessagePartsDto,
} from "@ai-chat/contracts";
import type { ModelMessage } from "ai";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import { toModelMessages } from "./history";
import type { MessageTokenCount } from "./types";

// 修改 tokenizer、协议开销或历史投影时一起升级；附件的计数版本单独管理。
export const TOKENIZER_ID = "o200k_base-js-tiktoken-1.0.21-estimate-v2";
export const MESSAGE_TOKEN_VERSION = `${TOKENIZER_ID}:history-v1`;
let tokenizer: Tiktoken | undefined;

/** 本地估算，不是服务端账单计数；分段防止超长重复字符串导致 BPE 病态耗时。 */
export function countTextTokens(text: string): number {
  tokenizer ??= new Tiktoken(o200kBase);
  let count = 0;
  for (let offset = 0; offset < text.length; offset += 4096) {
    count += tokenizer.encode(text.slice(offset, offset + 4096), [], []).length;
  }
  return count;
}

export function countModelMessages(
  messages: ModelMessage[],
  fileTokens: (url: string) => number = () => {
    throw new Error("ATTACHMENT_TOKEN_COUNT_MISSING: 附件应先按实际内容估算");
  },
): number {
  return messages.reduce((total, message) => {
    if (typeof message.content === "string")
      return total + 12 + countTextTokens(message.content);
    return (
      total +
      12 +
      message.content.reduce((tokens, part) => {
        if (part.type === "file") return tokens + fileTokens(String(part.data));
        if (part.type === "image")
          return tokens + fileTokens(String(part.image));
        return tokens + countTextTokens(JSON.stringify(part) ?? "");
      }, 0)
    );
  }, 0);
}

/** 新用户消息入库、助手完成/停止定稿时调用；不在流式 delta 阶段重复计算。 */
export function countStoredMessage(
  message:
    | { role: "user"; parts: UserMessagePartsDto }
    | { role: "assistant"; parts: AssistantMessagePartsDto },
): MessageTokenCount {
  const projection =
    message.role === "assistant"
      ? toModelMessages(message)
      : toModelMessages({
          role: "user",
          parts: message.parts.map((part) =>
            part.type === "text"
              ? part
              : {
                  type: "file",
                  url: `attachment:${part.attachmentId}`,
                  mediaType: "application/octet-stream",
                },
          ),
        });
  return {
    version: MESSAGE_TOKEN_VERSION,
    textTokens: countModelMessages(projection, () => 0),
  };
}
