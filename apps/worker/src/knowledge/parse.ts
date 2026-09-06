import { KNOWLEDGE_MAX_BYTES, type KnowledgeChunk } from "@ai-chat/contracts";
import { PDFParse } from "pdf-parse";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

class UnicodeTextSplitter extends RecursiveCharacterTextSplitter {
  override splitOnSeparator(text: string, separator: string) {
    // 库的空分隔符回退使用 split("")；仅改为按码点拆分，避免切断 emoji。
    return separator
      ? super.splitOnSeparator(text, separator)
      : Array.from(text);
  }
}

export async function chunkPages(
  pages: { page: number; text: string }[],
  size = 800,
  overlap = 100,
): Promise<KnowledgeChunk[]> {
  if (
    !Number.isInteger(size) ||
    !Number.isInteger(overlap) ||
    size < 1 ||
    overlap < 0 ||
    overlap >= size
  )
    throw new Error("INVALID_CHUNK_SIZE");
  const splitter = new UnicodeTextSplitter({
    chunkSize: size,
    chunkOverlap: overlap,
    separators: ["\n\n", "\n", "。", "！", "？", ";", "；", "，", ",", " ", ""],
    keepSeparator: true,
  });
  const chunks: KnowledgeChunk[] = [];
  for (const { page, text } of pages) {
    let searchFrom = 0;
    for (const content of await splitter.splitText(text)) {
      // splitter 保留分隔符但会 trim；从前一块允许的重叠范围定位原文。
      const start = text.indexOf(content, searchFrom);
      if (start < 0) throw new Error("CHUNK_LOCATION_NOT_FOUND");
      const end = start + content.length;
      chunks.push({ content, page, start, end });
      if (chunks.length > 1000) throw new Error("DOCUMENT_TOO_LARGE");
      searchFrom = Math.max(start + 1, end - overlap);
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
