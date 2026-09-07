import {
  createKnowledgeUploadResponseSchema,
  deleteKnowledgeBaseResponseSchema,
  knowledgeDocumentInputSchema,
  knowledgeBaseListSchema,
  knowledgeBaseSchema,
  knowledgeDocumentListSchema,
  knowledgeDocumentSchema,
} from "@ai-chat/contracts";

export async function knowledgeRequest(path: string, init?: RequestInit) {
  const response = await fetch(`/api/knowledge-bases${path}`, init);
  const data: unknown = await response.json();
  if (!response.ok) {
    const code =
      data && typeof data === "object" && "code" in data
        ? String(data.code)
        : "";
    const messages: Record<string, string> = {
      UNAUTHORIZED: "请重新登录",
      KNOWLEDGE_NOT_FOUND: "知识库或文件不存在",
      INVALID_REQUEST: "请检查名称或文件格式（TXT、Markdown、PDF，最大 10 MB）",
      KNOWLEDGE_UPLOAD_NOT_FOUND: "文件尚未上传完成，请删除待上传记录后重试",
      KNOWLEDGE_METADATA_MISMATCH:
        "上传文件的大小或类型不匹配，请删除待上传记录后重试",
      KNOWLEDGE_UPLOAD_FAILED: "上传或提交处理失败，请删除失败文件后重新上传",
      KNOWLEDGE_OBJECT_DELETE_FAILED: "文件已退出知识库，但原文件清理失败",
    };
    throw new Error(messages[code] ?? "操作失败，请稍后重试");
  }
  return data;
}
export async function fetchKnowledgeBases(signal?: AbortSignal) {
  return knowledgeBaseListSchema.parse(await knowledgeRequest("", { signal }))
    .bases;
}
export async function createKnowledgeBase(name: string) {
  return knowledgeBaseSchema.parse(
    await knowledgeRequest("", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
}
export async function removeKnowledgeBase(baseId: string) {
  return deleteKnowledgeBaseResponseSchema.parse(
    await knowledgeRequest(`/${encodeURIComponent(baseId)}`, {
      method: "DELETE",
    }),
  );
}
export async function fetchKnowledgeDocuments(
  baseId: string,
  signal?: AbortSignal,
) {
  return knowledgeDocumentListSchema.parse(
    await knowledgeRequest(`/${encodeURIComponent(baseId)}/documents`, {
      signal,
    }),
  ).documents;
}
export async function uploadKnowledgeFile(baseId: string, file: File) {
  // 浏览器对 TXT/Markdown 的 MIME 识别不一致，按支持的扩展名统一上传类型。
  const mediaTypes: Record<string, string> = {
    txt: "text/plain",
    md: "text/markdown",
    pdf: "application/pdf",
  };
  const input = knowledgeDocumentInputSchema.safeParse({
    originalName: file.name,
    mediaType: mediaTypes[file.name.split(".").at(-1)?.toLowerCase() ?? ""],
    sizeBytes: file.size,
  });
  if (!input.success) {
    throw new Error("请选择非空的 TXT、Markdown 或 PDF 文件，最大 10 MB");
  }
  const path = `/${encodeURIComponent(baseId)}/documents`;
  const { document, upload } = createKnowledgeUploadResponseSchema.parse(
    await knowledgeRequest(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.data),
    }),
  );
  // 文件本体只发送给预签名 R2 地址，不经过 Web API。
  try {
    const response = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body: file,
    });
    if (!response.ok) throw new Error("UPLOAD_FAILED");
  } catch {
    throw new Error("文件上传失败，请删除待上传记录后重新上传");
  }
  return knowledgeDocumentSchema.parse(
    await knowledgeRequest(
      `${path}/${encodeURIComponent(document.id)}/complete`,
      {
        method: "POST",
      },
    ),
  );
}
export async function removeKnowledgeFile(baseId: string, documentId: string) {
  await knowledgeRequest(
    `/${encodeURIComponent(baseId)}/documents/${encodeURIComponent(documentId)}`,
    { method: "DELETE" },
  );
}
