import {
  createOpenAI,
  type OpenAIProviderSettings,
} from "@ai-sdk/openai";
import { generateImage } from "ai";

import type { ImageModel } from "./image-model";

export type CatApiImageModelConfig = {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  fetch?: OpenAIProviderSettings["fetch"];
};

export function createCatApiImageModel(
  config: CatApiImageModelConfig,
): ImageModel {
  const provider = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    fetch: config.fetch,
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
