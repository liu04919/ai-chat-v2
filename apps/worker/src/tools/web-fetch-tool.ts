import { tool } from "ai";
import { z } from "zod";

import { createDeepSeekWebClient, type DeepSeekWebToolOptions } from "./deepseek-web-client";

export const MAX_WEB_CONTENT_CHARACTERS = 20_000;
export const webFetchInputSchema = z.object({
  url: z.url({ protocol: /^https?$/ }).max(8192).refine((value) => {
    try {
      const url = new URL(value);
      return !url.username && !url.password;
    } catch {
      return false;
    }
  }, "网页地址不能包含用户名或密码").describe("搜索结果或用户提供的公开 HTTP/HTTPS 网页地址"),
});
const fetchResponseSchema = z.object({ title: z.string(), content: z.string() });

export function createDeepSeekWebFetchTool(options: DeepSeekWebToolOptions) {
  const request = createDeepSeekWebClient(options);
  return tool({
    description:
      "读取一个公开网页，返回标题和 Markdown 正文。用于阅读用户提供的链接，或补充 web_search 摘要中缺少的细节；不支持登录后的私有页面。正文过长会截断并标记 truncated。",
    inputSchema: webFetchInputSchema,
    execute: async ({ url }, { abortSignal }) => {
      const page = await request("fetch", { url }, fetchResponseSchema, abortSignal);
      const characters = Array.from(page.content);
      return {
        url,
        title: page.title.trim() || url,
        content: characters.slice(0, MAX_WEB_CONTENT_CHARACTERS).join(""),
        truncated: characters.length > MAX_WEB_CONTENT_CHARACTERS,
      };
    },
  });
}
