import { KNOWLEDGE_MAX_BYTES, type KnowledgeChunk } from "@ai-chat/contracts";
import { PDFParse } from "pdf-parse";

export function chunkPages(
  pages: { page: number; text: string }[],
  size = 800,
  overlap = 100,
): KnowledgeChunk[] {
  if (size < 1 || overlap < 0 || overlap >= size)
    throw new Error("INVALID_CHUNK_SIZE");
  const chunks: KnowledgeChunk[] = [];
  for (const { page, text } of pages) {
    for (let start = 0; start < text.length; ) {
      let end = Math.min(start + size, text.length);
      // UTF-16 下 emoji 可能占两个码元，不能把代理对切成无法入库的半个字符。
      if (
        end < text.length &&
        /[\uD800-\uDBFF]/.test(text[end - 1]!) &&
        /[\uDC00-\uDFFF]/.test(text[end]!)
      )
        end++;
      if (text.slice(start, end).trim())
        chunks.push({ content: text.slice(start, end), page, start, end });
      if (chunks.length > 1000) throw new Error("DOCUMENT_TOO_LARGE");
      if (end === text.length) break;
      start = end - overlap;
      if (/[\uDC00-\uDFFF]/.test(text[start] ?? "")) start++;
    }
  }
  if (!chunks.length) throw new Error("NO_EXTRACTABLE_TEXT");
  return chunks;
}

export async function parseKnowledgeFile(bytes: Uint8Array, mediaType: string) {
  if (!bytes.length || bytes.length > KNOWLEDGE_MAX_BYTES)
    throw new Error("INVALID_FILE_SIZE");
  if (mediaType === "text/plain" || mediaType === "text/markdown") {
    return chunkPages([
      {
        page: 1,
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      },
    ]);
  }
  if (mediaType !== "application/pdf")
    throw new Error("UNSUPPORTED_MEDIA_TYPE");
  const parser = new PDFParse({ data: bytes, isEvalSupported: false });
  try {
    const info = await parser.getInfo();
    if (info.total > 200) throw new Error("DOCUMENT_TOO_LARGE");
    const result = await parser.getText();
    return chunkPages(result.pages.map((p) => ({ page: p.num, text: p.text })));
  } finally {
    await parser.destroy();
  }
}
