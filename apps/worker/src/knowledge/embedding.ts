import { KNOWLEDGE_DIMENSIONS } from "@ai-chat/contracts";
import { validateKnowledgeVector } from "@ai-chat/db";
import { createOpenAI } from "@ai-sdk/openai";
import { embedMany } from "ai";

export type KnowledgeEmbedder = {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
};

export function createKnowledgeEmbedder(
  env: NodeJS.ProcessEnv = process.env,
): KnowledgeEmbedder {
  const {
    EMBEDDING_BASE_URL: baseURL,
    DASHSCOPE_API_KEY: apiKey,
    EMBEDDING_MODEL: model,
  } = env;
  if (!baseURL || !apiKey || !model)
    throw new Error("EMBEDDING_NOT_CONFIGURED");
  if (
    Number(env.EMBEDDING_DIMENSIONS ?? KNOWLEDGE_DIMENSIONS) !==
    KNOWLEDGE_DIMENSIONS
  )
    throw new Error("EMBEDDING_DIMENSION_MISMATCH");
  const provider = createOpenAI({ baseURL, apiKey });
  return {
    model,
    async embed(texts) {
      const vectors: number[][] = [];
      for (let offset = 0; offset < texts.length; offset += 10) {
        const batch = texts.slice(offset, offset + 10);
        const result = await embedMany({
          model: provider.embeddingModel(model),
          values: batch,
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(60_000),
          providerOptions: { openai: { dimensions: KNOWLEDGE_DIMENSIONS } },
        });
        if (result.embeddings.length !== batch.length)
          throw new Error("INVALID_EMBEDDING_COUNT");
        result.embeddings.forEach(validateKnowledgeVector);
        vectors.push(...result.embeddings);
      }
      return vectors;
    },
  };
}
