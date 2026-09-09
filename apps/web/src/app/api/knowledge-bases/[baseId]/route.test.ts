import { beforeEach, describe, expect, it, vi } from "vitest";
import { createKnowledgeRepository } from "@ai-chat/db";
import { getCurrentSession } from "@/server/auth/session";
import { getObjectStorage } from "@/server/object-storage";
import { deleteKnowledgeBase, deleteKnowledgeDocument } from "@/server/knowledge/service";
import { DELETE as deleteBase } from "./route";
import { DELETE as deleteDocument } from "./documents/[documentId]/route";

vi.mock("@/server/auth/session", () => ({ getCurrentSession: vi.fn() }));
// Vitest 不解析 Next 的路径别名；这里仍复用真实的鉴权和错误映射。
vi.mock("@/server/knowledge/http", () => import("../../../../server/knowledge/http"));
vi.mock("@ai-chat/db", () => ({ createKnowledgeRepository: vi.fn(() => ({})) }));
vi.mock("@/server/object-storage", () => ({ getObjectStorage: vi.fn(() => ({})) }));
vi.mock("@/server/knowledge/service", () => ({ deleteKnowledgeBase: vi.fn(), deleteKnowledgeDocument: vi.fn() }));

const getSession = vi.mocked(getCurrentSession);
const removeBase = vi.mocked(deleteKnowledgeBase);
const removeDocument = vi.mocked(deleteKnowledgeDocument);
const context = { params: Promise.resolve({ baseId: "kb", documentId: "doc" }) };
const request = () => new Request("http://localhost/api/knowledge-bases/kb", { method: "DELETE" });

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: "owner" } } as Awaited<ReturnType<typeof getCurrentSession>>);
  removeBase.mockResolvedValue({ baseId: "kb", cleanupFailed: false });
  removeDocument.mockResolvedValue({ documentId: "doc" });
});

describe("知识库删除 API 协议", () => {
  it("未登录不能删除知识库或文档，也不创建存储依赖", async () => {
    getSession.mockResolvedValue(null);
    for (const handler of [deleteBase, deleteDocument]) {
      const response = await handler(request(), context);
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ code: "UNAUTHORIZED" });
    }
    expect(removeBase).not.toHaveBeenCalled();
    expect(removeDocument).not.toHaveBeenCalled();
    expect(createKnowledgeRepository).not.toHaveBeenCalled();
    expect(getObjectStorage).not.toHaveBeenCalled();
  });

  it("删除文档只返回协议中的 documentId", async () => {
    const response = await deleteDocument(request(), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ documentId: "doc" });
    expect(removeDocument).toHaveBeenCalledExactlyOnceWith("owner", "kb", "doc", {
      repository: createKnowledgeRepository(), storage: getObjectStorage(),
    });
  });

  it.each([false, true])("删除知识库保留 cleanupFailed=%s", async (cleanupFailed) => {
    removeBase.mockResolvedValue({ baseId: "kb", cleanupFailed });
    const response = await deleteBase(request(), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ baseId: "kb", cleanupFailed });
  });

  it("对象清理失败保留原来的 503 和错误码", async () => {
    removeDocument.mockRejectedValue(new Error("KNOWLEDGE_OBJECT_DELETE_FAILED"));
    const response = await deleteDocument(request(), context);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "KNOWLEDGE_OBJECT_DELETE_FAILED" });
  });
});
