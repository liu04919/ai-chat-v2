import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { knowledgeDocumentInputSchema, knowledgeErrorResponseSchema } from "@ai-chat/contracts";
import { KnowledgeNotFoundError } from "@ai-chat/db";
import { getCurrentSession } from "@/server/auth/session";
import { knowledgeHttp } from "./http";
import { KnowledgeServiceError } from "./errors";

vi.mock("@/server/auth/session", () => ({ getCurrentSession: vi.fn() }));
const getSession = vi.mocked(getCurrentSession);

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: "owner" } } as Awaited<ReturnType<typeof getCurrentSession>>);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("知识库 HTTP 错误边界", () => {
  it("未登录返回标准 401，不能执行数据库或对象存储操作", async () => {
    getSession.mockResolvedValue(null);
    const action = vi.fn();
    const response = await knowledgeHttp(action);
    expect(response.status).toBe(401);
    expect(knowledgeErrorResponseSchema.parse(await response.json())).toEqual({ code: "UNAUTHORIZED" });
    expect(action).not.toHaveBeenCalled();
  });

  it("成功路径只使用服务端会话里的 ownerId", async () => {
    const expected = Response.json({ documentId: "doc" });
    const action = vi.fn().mockResolvedValue(expected);
    expect(await knowledgeHttp(action)).toBe(expected);
    expect(action).toHaveBeenCalledExactlyOnceWith("owner");
  });

  it.each([
    ["INVALID_REQUEST", 400], ["KNOWLEDGE_NOT_FOUND", 404],
    ["KNOWLEDGE_UPLOAD_NOT_FOUND", 409], ["KNOWLEDGE_METADATA_MISMATCH", 409],
    ["KNOWLEDGE_UPLOAD_FAILED", 503], ["KNOWLEDGE_OBJECT_DELETE_FAILED", 503],
  ] as const)("%s 保持原有 HTTP 状态 %i", async (code, status) => {
    const response = await knowledgeHttp(async () => { throw new KnowledgeServiceError(code); });
    expect(response.status).toBe(status);
    expect(knowledgeErrorResponseSchema.parse(await response.json())).toEqual({ code });
  });

  it("数据层的未找到错误映射到 404，不把 HTTP 状态放进数据库模块", async () => {
    const response = await knowledgeHttp(async () => { throw new KnowledgeNotFoundError(); });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ code: "KNOWLEDGE_NOT_FOUND" });
  });

  it("错误消息变化不会影响业务 code 和 HTTP 状态", async () => {
    const error = new KnowledgeServiceError("KNOWLEDGE_UPLOAD_FAILED");
    error.message = "internal enqueue diagnostic";
    const response = await knowledgeHttp(async () => { throw error; });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "KNOWLEDGE_UPLOAD_FAILED" });
  });

  it.each(["schema", "json"])("请求解析失败返回 INVALID_REQUEST：%s", async (kind) => {
    const response = await knowledgeHttp(async () => {
      if (kind === "schema") knowledgeDocumentInputSchema.parse({});
      JSON.parse("invalid json");
      return Response.json({});
    });
    expect(response.status).toBe(400);
    expect(knowledgeErrorResponseSchema.parse(await response.json())).toEqual({ code: "INVALID_REQUEST" });
  });

  it.each([
    new Error("private connection details"), new Error("toString"),
    new Error("KNOWLEDGE_NOT_FOUND"), new Error("INVALID_REQUEST"),
    { code: "KNOWLEDGE_NOT_FOUND" }, { private: "upstream response" },
  ])(
    "未识别的异常统一返回 INTERNAL_ERROR，不泄露详情", async (error) => {
      const response = await knowledgeHttp(async () => { throw error; });
      expect(response.status).toBe(500);
      expect(knowledgeErrorResponseSchema.parse(await response.json())).toEqual({ code: "INTERNAL_ERROR" });
      expect(console.error).toHaveBeenCalledExactlyOnceWith("Knowledge API failed");
    },
  );
});
