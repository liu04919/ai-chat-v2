import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeNotFoundError } from "@ai-chat/db";
import {
  completeKnowledgeUpload,
  deleteKnowledgeDocument,
  type KnowledgeServiceDependencies,
} from "./service";

type Repository = KnowledgeServiceDependencies["repository"];
const document: Awaited<ReturnType<Repository["getDocument"]>> = {
  id: "doc", knowledgeBaseId: "kb", objectKey: "knowledge/object",
  originalName: "notes.txt", mediaType: "text/plain", sizeBytes: 5,
  status: "uploading", embeddingModel: null, chunkCount: 0, errorCode: null,
  createdAt: new Date("2026-09-09T00:00:00Z"),
  updatedAt: new Date("2026-09-09T00:00:00Z"),
};
const getDocument = vi.fn<Repository["getDocument"]>();
const confirmUpload = vi.fn<Repository["confirmUpload"]>();
const deleteDocument = vi.fn<Repository["deleteDocument"]>();
const fail = vi.fn<Repository["fail"]>();
// 只替换这两个服务真正调用的数据库方法，不连接数据库或真实 R2。
const repository = { getDocument, confirmUpload, deleteDocument, fail } as unknown as Repository;
const dependencies: KnowledgeServiceDependencies = {
  repository,
  storage: {
    createUploadUrl: vi.fn(),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  },
  enqueue: vi.fn(),
};

beforeEach(() => {
  vi.resetAllMocks();
  getDocument.mockResolvedValue(document);
  confirmUpload.mockResolvedValue({ ...document, status: "pending" });
  deleteDocument.mockResolvedValue(document);
  vi.mocked(dependencies.storage.headObject).mockResolvedValue({
    sizeBytes: 5, contentType: "text/plain",
  });
});

describe("知识库业务错误", () => {
  it("未找到资源保留数据层的明确类型，并停止后续对象访问", async () => {
    const error = new KnowledgeNotFoundError();
    getDocument.mockRejectedValue(error);
    await expect(completeKnowledgeUpload("owner", "kb", "doc", dependencies)).rejects.toBe(error);
    expect(dependencies.storage.headObject).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    [null, "KNOWLEDGE_UPLOAD_NOT_FOUND"],
    [{ sizeBytes: 6, contentType: "text/plain" }, "KNOWLEDGE_METADATA_MISMATCH"],
  ] as const)("核验上传失败返回显式业务错误：%s", async (metadata, code) => {
    vi.mocked(dependencies.storage.headObject).mockResolvedValue(metadata);
    await expect(completeKnowledgeUpload("owner", "kb", "doc", dependencies))
      .rejects.toMatchObject({ name: "KnowledgeServiceError", code });
    expect(confirmUpload).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it("入队失败标记文档失败，并抛出带 code 的错误", async () => {
    vi.mocked(dependencies.enqueue).mockRejectedValue(new Error("private queue details"));
    await expect(completeKnowledgeUpload("owner", "kb", "doc", dependencies))
      .rejects.toMatchObject({ name: "KnowledgeServiceError", code: "KNOWLEDGE_UPLOAD_FAILED" });
    expect(fail).toHaveBeenCalledExactlyOnceWith("doc", "ENQUEUE_FAILED", "pending");
  });

  it("删除不存在的文档不清理对象", async () => {
    deleteDocument.mockResolvedValue(undefined);
    await expect(deleteKnowledgeDocument("owner", "kb", "missing", dependencies))
      .rejects.toMatchObject({ name: "KnowledgeServiceError", code: "KNOWLEDGE_NOT_FOUND" });
    expect(dependencies.storage.deleteObject).not.toHaveBeenCalled();
  });

  it("删除对象失败保持既有业务错误码，不暴露底层异常", async () => {
    vi.mocked(dependencies.storage.deleteObject).mockRejectedValue(new Error("private R2 details"));
    await expect(deleteKnowledgeDocument("owner", "kb", "doc", dependencies))
      .rejects.toMatchObject({ name: "KnowledgeServiceError", code: "KNOWLEDGE_OBJECT_DELETE_FAILED" });
    expect(deleteDocument).toHaveBeenCalledExactlyOnceWith("owner", "kb", "doc");
  });

  it("未分类的基础设施故障原样交给 HTTP 边界处理为 500", async () => {
    const error = new Error("KNOWLEDGE_UPLOAD_NOT_FOUND");
    vi.mocked(dependencies.storage.headObject).mockRejectedValue(error);
    await expect(completeKnowledgeUpload("owner", "kb", "doc", dependencies)).rejects.toBe(error);
  });
});
