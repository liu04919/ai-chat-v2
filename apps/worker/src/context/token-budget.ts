import { asSchema, type ToolSet } from "ai";
import { countTextTokens } from "@ai-chat/model-context";
export {
  countTextTokens,
  countModelMessages,
  TOKENIZER_ID,
} from "@ai-chat/model-context";

// 本地代理的保守工程预算，不把官方最大上下文当作已验证的代理容量。
export const CHAT_CONTEXT_POLICY = {
  triggerTokens: 200_000,
  targetTokens: 60_000,
  summaryTokens: 8_000,
  maxInputTokens: 240_000,
  maxOutputTokens: 16_000,
  summaryBatchTokens: 100_000,
} as const;
export type ContextPolicy = { [K in keyof typeof CHAT_CONTEXT_POLICY]: number };
function countContent(value: unknown): number {
  return countTextTokens(JSON.stringify(value) ?? "");
}

export async function countRequestOverhead(
  instructions?: string,
  tools?: ToolSet,
): Promise<number> {
  const definitions = await Promise.all(
    Object.entries(tools ?? {}).map(async ([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: await asSchema(tool.inputSchema).jsonSchema,
      inputExamples: tool.inputExamples,
      ...(tool.type === "provider" ? { id: tool.id, args: tool.args } : {}),
    })),
  );
  // 额外预留协议、角色封装等开销；工具执行函数本身不会发给模型。
  return 1024 + countTextTokens(instructions ?? "") + countContent(definitions);
}

export function assertInputBudget(
  tokens: number,
  limit: number = CHAT_CONTEXT_POLICY.maxInputTokens,
): void {
  if (tokens > limit) {
    throw new Error(
      `CHAT_CONTEXT_TOO_LARGE: 估算输入 ${tokens} tokens 超出 ${limit} 的安全预算，请缩短问题、附件或工具结果`,
    );
  }
}
