import { tool } from "ai";
import { z } from "zod";

import { createDeepSeekWebClient, type DeepSeekWebToolOptions } from "./deepseek-web-client";

export const webSearchInputSchema = z.object({
  query: z.string().trim().min(1)
    .refine((value) => Array.from(value).length <= 128, "搜索词最多 128 个 Unicode 字符")
    .describe("1～128 个 Unicode 字符的简短搜索词，可使用 site: 等搜索语法"),
  maxResults: z.number().int().min(1).max(8).default(5),
});

const searchResponseSchema = z.object({
  results: z.array(z.object({
    title: z.string().nullish(),
    url: z.url({ protocol: /^https?$/ }),
    summary: z.string().nullish(),
    snippet: z.string().nullish(),
    date: z.string().nullish(),
  })),
});

export function createDeepSeekWebSearchTool(options: DeepSeekWebToolOptions) {
  const request = createDeepSeekWebClient(options);

  return tool({
    description:
      "搜索互联网中的最新信息并返回可引用来源和摘要。遇到可能变化的事实时使用；需要网页原文细节时再调用 web_fetch。",
    inputSchema: webSearchInputSchema,
    execute: async ({ query, maxResults }, { abortSignal }) => {
      const parsed = await request("search", {
        query,
        count: maxResults,
        need_content: false,
      }, searchResponseSchema, abortSignal);

      return {
        query,
        results: parsed.results.slice(0, maxResults).map((result) => ({
          title: result.title?.trim() || result.url,
          url: result.url,
          snippet: result.summary?.trim() || result.snippet?.trim() || "",
          ...(result.date
            ? { publishedAt: result.date }
            : {}),
        })),
      };
    },
  });
}
