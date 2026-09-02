import { tool } from "ai";
import { z } from "zod";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

const tavilySearchResponseSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            title: z.string().optional(),
            url: z.url(),
            content: z.string().optional(),
            published_date: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export type TavilyWebSearchToolOptions = {
  apiKey: string;
  fetch?: typeof fetch;
  endpoint?: string;
};

export function createTavilyWebSearchTool(
  options: TavilyWebSearchToolOptions,
) {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY 不能为空");
  }

  const request = options.fetch ?? fetch;
  const endpoint = options.endpoint ?? TAVILY_SEARCH_URL;

  return tool({
    description:
      "搜索互联网中的最新信息并返回可引用来源。遇到新闻、价格、政策、版本、人物职务或其他可能变化的事实时使用。",
    inputSchema: z.object({
      query: z.string().trim().min(2).max(400),
      maxResults: z.number().int().min(1).max(8).default(5),
    }),
    execute: async ({ query, maxResults }, { abortSignal }) => {
      const response = await request(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          topic: "general",
          search_depth: "basic",
          max_results: maxResults,
          include_answer: false,
          include_images: false,
          include_raw_content: false,
          auto_parameters: false,
        }),
        signal: abortSignal,
      });

      if (!response.ok) {
        throw new Error(`Tavily 搜索失败（HTTP ${response.status}）`);
      }

      const parsed = tavilySearchResponseSchema.parse(await response.json());

      return {
        query,
        results: parsed.results.map((result) => ({
          title: result.title?.trim() || result.url,
          url: result.url,
          snippet: result.content?.trim() || "",
          ...(result.published_date
            ? { publishedAt: result.published_date }
            : {}),
        })),
      };
    },
  });
}
