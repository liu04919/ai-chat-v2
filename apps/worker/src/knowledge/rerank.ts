import { z } from "zod";
import type { KnowledgeHit } from "@ai-chat/db";

export type RerankedKnowledgeHit = KnowledgeHit & { rerankScore: number };
export type KnowledgeReranker = {
  model: string;
  rerank(
    query: string,
    candidates: KnowledgeHit[],
  ): Promise<{
    hits: RerankedKnowledgeHit[];
    totalTokens: number | null;
    requestId: string | null;
  }>;
};

const responseSchema = z.object({
  output: z.object({
    results: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        relevance_score: z.number().finite().min(0).max(1),
      }),
    ),
  }),
  usage: z.object({ total_tokens: z.number().int().nonnegative() }).optional(),
  request_id: z.string().optional(),
});

export function createKnowledgeReranker(
  env: NodeJS.ProcessEnv = process.env,
): KnowledgeReranker {
  const {
    RERANK_BASE_URL: baseURL,
    DASHSCOPE_API_KEY: apiKey,
    RERANK_MODEL: model,
  } = env;
  if (!baseURL || !apiKey || !model) throw new Error("RERANK_NOT_CONFIGURED");
  const endpoint = `${baseURL.replace(/\/$/, "")}/services/rerank/text-rerank/text-rerank`;
  return {
    model,
    async rerank(query, candidates) {
      if (!query.trim() || query.length > 2000 || candidates.length > 60)
        throw new Error("INVALID_RERANK_INPUT");
      if (!candidates.length)
        return { hits: [], totalTokens: 0, requestId: null };
      const topN = Math.min(6, candidates.length);
      try {
        // 仅传 chunk 正文，不发送账户、对象存储 key 或其他内部元数据。
        const response = await fetch(endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(60_000),
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            input: { query, documents: candidates.map((c) => c.content) },
            parameters: { top_n: topN },
          }),
        });
        if (!response.ok) throw new Error("RERANK_HTTP_ERROR");
        const data = responseSchema.parse(await response.json());
        const results = data.output.results;
        if (
          results.length !== topN ||
          new Set(results.map((r) => r.index)).size !== results.length ||
          results.some((r) => r.index >= candidates.length)
        ) {
          throw new Error("INVALID_RERANK_RESULTS");
        }
        const hits = [...results]
          .sort(
            (a, b) =>
              b.relevance_score - a.relevance_score || a.index - b.index,
          )
          .map((r) => ({
            ...candidates[r.index]!,
            rerankScore: r.relevance_score,
          }));
        return {
          hits,
          totalTokens: data.usage?.total_tokens ?? null,
          requestId: data.request_id ?? null,
        };
      } catch {
        // 上游异常可能带请求正文或凭证；不透传，也不把失败伪装成成功降级。
        throw new Error("RERANK_FAILED");
      }
    },
  };
}
