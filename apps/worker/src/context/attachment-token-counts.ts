import { imageSize } from "image-size";
import { PDFParse } from "pdf-parse";
import {
  saveAttachmentTokenCount,
  type ClaimedGenerationExecution,
} from "@ai-chat/db";
import {
  countTextTokens,
  TOKENIZER_ID,
  type AttachmentTokenCount,
} from "@ai-chat/model-context";
import type { ObjectStorage } from "@ai-chat/storage";

export const ATTACHMENT_TOKEN_VERSION = `${TOKENIZER_ID}:sol-auto-image-patches-pdf-high-v1`;

/** Sol 的 auto=original：32×32 patch，尺寸至多 65535，乘 1.2 向上取整。 */
export function countSolImageTokens(width: number, height: number): number {
  if (
    ![width, height].every((value) => Number.isSafeInteger(value) && value > 0)
  ) {
    throw new Error("ATTACHMENT_INVALID_IMAGE_SIZE");
  }
  const scale = Math.min(1, 65535 / Math.max(width, height));
  const patches =
    Math.ceil(Math.ceil(width * scale) / 32) *
    Math.ceil(Math.ceil(height * scale) / 32);
  if (patches > 30000)
    throw new Error("ATTACHMENT_IMAGE_TOO_LARGE: 请缩小图片后重试");
  return Math.ceil(patches * 1.2);
}

export async function inspectAttachmentTokens(
  bytes: Uint8Array,
  mediaType: string,
  signal: AbortSignal,
): Promise<AttachmentTokenCount> {
  signal.throwIfAborted();
  if (!bytes.length || bytes.length > 10 * 1024 * 1024)
    throw new Error("ATTACHMENT_INVALID_FILE_SIZE");
  if (mediaType.startsWith("image/")) {
    const { width, height } = imageSize(bytes);
    return {
      version: ATTACHMENT_TOKEN_VERSION,
      etag: null,
      kind: "image",
      width,
      height,
      tokens: countSolImageTokens(width, height),
    };
  }
  if (mediaType !== "application/pdf")
    throw new Error("ATTACHMENT_UNSUPPORTED_MEDIA_TYPE");
  const parser = new PDFParse({ data: bytes, isEvalSupported: false });
  try {
    const info = await parser.getInfo();
    signal.throwIfAborted();
    const result = await parser.getText();
    signal.throwIfAborted();
    const textTokens = result.pages.reduce(
      (sum, page) => sum + countTextTokens(page.text),
      0,
    );
    // PDF 原生输入包含文字和每页图像。Sol auto=high；不猜测服务端渲染 DPI，
    // 每页按 high 的 2500 patches × 1.2 预留。它是逐页保守估算，不是精确账单。
    // https://developers.openai.com/api/docs/guides/file-inputs#pdf-detail-levels
    return {
      version: ATTACHMENT_TOKEN_VERSION,
      etag: null,
      kind: "pdf",
      pages: info.total,
      textTokens,
      tokens: textTokens + info.total * 3000,
    };
  } finally {
    await parser.destroy();
  }
}

export type AttachmentTokenCounter = (
  execution: ClaimedGenerationExecution,
  signal: AbortSignal,
) => Promise<Map<string, number>>;

export function createAttachmentTokenCounter(dependencies: {
  storage: Pick<ObjectStorage, "headObject" | "readObject">;
  modelId: string;
  save?: typeof saveAttachmentTokenCount;
  inspect?: typeof inspectAttachmentTokens;
}): AttachmentTokenCounter {
  const save = dependencies.save ?? saveAttachmentTokenCount;
  const inspect = dependencies.inspect ?? inspectAttachmentTokens;
  return async (execution, signal) => {
    const counts = new Map<string, number>();
    const needed = new Set(
      execution.messages.flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "attachment" ? [part.attachmentId] : [],
        ),
      ),
    );
    if (!needed.size) return counts;
    if (dependencies.modelId !== "gpt-5.6-sol")
      throw new Error(
        "ATTACHMENT_TOKEN_MODEL_UNSUPPORTED: 需要为当前模型配置多模态计数规则",
      );
    for (const id of needed) {
      signal.throwIfAborted();
      const attachment = execution.attachments.find((item) => item.id === id);
      if (!attachment || attachment.status !== "ready")
        throw new Error("ATTACHMENT_NOT_READY");
      const metadata = await dependencies.storage.headObject(
        attachment.objectKey,
        signal,
      );
      if (!metadata) throw new Error("ATTACHMENT_UPLOAD_NOT_FOUND");
      const cached = attachment.contextTokenCount;
      if (
        metadata.etag &&
        cached?.etag === metadata.etag &&
        cached.version === ATTACHMENT_TOKEN_VERSION
      ) {
        counts.set(id, cached.tokens);
        continue;
      }
      // If-Match 绑定这次读取的对象版本；上传 URL 尚未过期时不能沿用被覆盖文件的缓存。
      const bytes = await dependencies.storage.readObject(
        attachment.objectKey,
        signal,
        metadata.etag ?? undefined,
      );
      const count = {
        ...(await inspect(bytes, attachment.mediaType, signal)),
        etag: metadata.etag ?? null,
      };
      signal.throwIfAborted();
      counts.set(id, count.tokens);
      try {
        await save({ ownerId: execution.ownerId, attachmentId: id, count });
      } catch {
        // 派生缓存写失败不影响本次已经取得的计数；下次使用时自然重算。
        console.warn("Attachment token cache was not saved", {
          attachmentId: id,
        });
      }
    }
    signal.throwIfAborted();
    return counts;
  };
}
