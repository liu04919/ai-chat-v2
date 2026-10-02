import {
  createOpenAI,
  type OpenAIProviderSettings,
} from "@ai-sdk/openai";
import { ATTACHMENT_MAX_SIZE_BYTES } from "@ai-chat/contracts";
import { createDownload, generateImage } from "ai";
import { z } from "zod";

import type { ImageModel } from "./image-model";

const downloadImage = createDownload({ maxBytes: ATTACHMENT_MAX_SIZE_BYTES });
const imageResponseSchema = z.object({
  data: z.array(z.object({
    b64_json: z.string().nullish(),
    url: z.string().optional(),
  }).passthrough()),
}).passthrough();

// 中转可能忽略响应格式并返回 URL；在 SDK 校验 b64_json 前统一成同一种格式。
async function normalizeImageResponse(
  response: Response,
  signal?: AbortSignal | null,
): Promise<Response> {
  if (!response.ok) return response;
  const parsed = imageResponseSchema.safeParse(
    await response.clone().json().catch(() => undefined),
  );
  if (!parsed.success) return response;
  const images = parsed.data.data;
  if (!images.some((image) => !image.b64_json && image.url)) return response;

  const timeout = AbortSignal.timeout(60_000);
  const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (const image of images) {
    if (image.b64_json || !image.url) continue;
    abortSignal.throwIfAborted();
    // 独立下载，不透传 API 鉴权；SDK 负责公网地址校验、重定向和大小限制。
    const downloaded = await downloadImage({ url: new URL(image.url), abortSignal });
    abortSignal.throwIfAborted();
    image.b64_json = Buffer.from(downloaded.data).toString("base64");
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return Response.json(parsed.data, { status: response.status, headers });
}

export type OpenAIImageModelConfig = {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  fetch?: OpenAIProviderSettings["fetch"];
};

export function createOpenAIImageModel(
  config: OpenAIImageModelConfig,
): ImageModel {
  const provider = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    fetch: async (input, init) => {
      const response = await (config.fetch ?? globalThis.fetch)(input, init);
      return normalizeImageResponse(
        response,
        init?.signal ?? (input instanceof Request ? input.signal : undefined),
      );
    },
  });
  const model = provider.image(config.modelId);

  return {
    async generate(request) {
      const prompt = request.referenceImage
        ? {
            text: request.prompt,
            images: [request.referenceImage],
          }
        : request.prompt;
      const result = await generateImage({
        model,
        prompt,
        n: 1,
        maxRetries: 0,
        abortSignal: request.abortSignal,
      });

      return {
        data: result.image.uint8Array,
        mediaType: result.image.mediaType,
      };
    },
  };
}
