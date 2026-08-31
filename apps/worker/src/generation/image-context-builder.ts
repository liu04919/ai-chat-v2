import type { ClaimedGenerationExecution } from "@ai-chat/db";
import type { ObjectStorage } from "@ai-chat/storage";

import type { ImageModelRequest } from "../llm/image-model";

export async function buildImageModelRequest(
  execution: ClaimedGenerationExecution,
  storage: Pick<ObjectStorage, "readObject">,
  abortSignal?: AbortSignal,
): Promise<ImageModelRequest> {
  if (execution.mode !== "image" || execution.reasoningEffort !== null) {
    throw new Error("Image Context Builder 只接受图片会话");
  }

  const currentIndex = execution.messages.findIndex(
    (message) => message.id === execution.userMessageId,
  );
  const current = execution.messages[currentIndex];

  if (!current || current.role !== "user") {
    throw new Error("找不到本轮 User Message");
  }

  const instruction = current.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
  if (!instruction) {
    throw new Error("图片生成必须包含本轮文字指令");
  }

  const currentImages = current.parts.filter(
    (part) => part.type === "attachment",
  );
  if (currentImages.length > 1) {
    throw new Error("图片生成只支持一张参考图");
  }

  const history = execution.messages.slice(0, currentIndex);
  // 只延续最近一次生成的图片，不把所有历史图片打包发给模型。
  const latestGeneratedImage = history
    .flatMap((message) =>
      message.role === "assistant"
        ? message.parts.filter((part) => part.type === "attachment")
        : [],
    )
    .at(-1);
  const reference = currentImages[0] ?? latestGeneratedImage;
  const historyText = history.map((message) => ({
    role: message.role,
    parts: message.parts.flatMap((part) => {
      switch (part.type) {
        case "text":
        case "reasoning":
          return [{ type: part.type, text: part.text }];
        case "attachment":
          return [
            {
              type: "image",
              text:
                part.attachmentId === reference?.attachmentId
                  ? "本次携带的参考图"
                  : "历史图片，本次未携带图像内容",
            },
          ];
        default:
          return [];
      }
    }),
  }));
  const prompt = [
    "请根据本轮指令生成或修改图片。以下历史仅用于理解上下文，以本轮指令为准。",
    `历史消息（按时间顺序）：\n${JSON.stringify(historyText)}`,
    reference
      ? currentImages.length
        ? "参考图：本轮用户提供的图片。"
        : "参考图：最近一次生成的图片。"
      : "本次没有参考图。",
    `本轮指令：\n${instruction}`,
  ].join("\n\n");

  abortSignal?.throwIfAborted();
  if (!reference) {
    return { prompt, abortSignal };
  }

  const attachment = execution.attachments.find(
    (item) => item.id === reference.attachmentId,
  );
  if (!attachment || attachment.status !== "ready") {
    throw new Error("参考图 Attachment 不存在或尚未 ready");
  }
  if (!attachment.mediaType.startsWith("image/")) {
    throw new Error("图片生成不支持 PDF 参考文件");
  }

  const referenceImage = await storage.readObject(
    attachment.objectKey,
    abortSignal,
  );
  abortSignal?.throwIfAborted();
  return { prompt, referenceImage, abortSignal };
}
