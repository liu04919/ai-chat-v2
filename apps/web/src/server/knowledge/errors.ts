import type { KnowledgeErrorCode } from "@ai-chat/contracts";

export type KnowledgeServiceErrorCode = Exclude<
  KnowledgeErrorCode,
  "UNAUTHORIZED" | "INTERNAL_ERROR"
>;

/** 可公开的业务失败由 code 表达；普通异常不能靠 message 冒充业务错误。 */
export class KnowledgeServiceError extends Error {
  constructor(readonly code: KnowledgeServiceErrorCode) {
    super(code);
    this.name = "KnowledgeServiceError";
  }
}
