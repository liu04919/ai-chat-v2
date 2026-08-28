import { randomUUID } from "node:crypto";

import { expect, it } from "vitest";

import { createCatApiChatModel } from "./cat-api-chat-model";

const runLiveTest = process.env.CAT_API_LIVE_TEST === "1" ? it : it.skip;

runLiveTest("通过 AI SDK Responses 读取真实 CatAPI 文本流", async () => {
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const modelId = process.env.LLM_MODEL;

  if (!baseUrl || !apiKey || !modelId) {
    throw new Error("CatAPI live test 缺少 LLM_BASE_URL、LLM_API_KEY 或 LLM_MODEL");
  }

  const marker = `catapi_adapter_${randomUUID()}`;
  const model = createCatApiChatModel({ baseUrl, apiKey, modelId });
  let text = "";
  let finished = false;

  for await (const part of model.stream({
    messages: [
      {
        role: "user",
        parts: [
          {
            type: "text",
            text: `不要解释，只原样回复这一段字符：${marker}`,
          },
        ],
      },
    ],
    reasoningEffort: "low",
  })) {
    if (part.type === "text") {
      text += part.delta;
    } else if (part.type === "finish") {
      finished = true;
    }
  }

  expect(text).toContain(marker);
  expect(finished).toBe(true);
});
