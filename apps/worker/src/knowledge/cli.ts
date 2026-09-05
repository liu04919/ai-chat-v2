import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { KNOWLEDGE_MAX_BYTES, KNOWLEDGE_QUEUE } from "@ai-chat/contracts";
import {
  closeApplicationDatabase,
  createKnowledgeRepository,
} from "@ai-chat/db";
import { createR2ObjectStorage } from "@ai-chat/storage";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { createKnowledgeEmbedder } from "./embedding";
import { retrieveKnowledge } from "./retrieve";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}
function storage() {
  return createR2ObjectStorage({
    endpoint: required("R2_ENDPOINT"),
    bucket: required("R2_BUCKET"),
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
  });
}

// 本地开发入口，不是公开 API；将来 HTTP 层必须从登录会话取得 ownerId。
async function main() {
  const [command, ownerId, baseOrName, argument] = process.argv.slice(2);
  if (!ownerId || !baseOrName)
    throw new Error(
      "用法：knowledge <create|status|upload|search|delete> <ownerId> <name|baseId> [file|query|documentId]",
    );
  const repository = createKnowledgeRepository();
  if (command === "create") return repository.createBase(ownerId, baseOrName);
  if (command === "status")
    return (await repository.listDocuments(ownerId, baseOrName)).map(
      ({ id, originalName, status, chunkCount, errorCode }) => ({
        id,
        originalName,
        status,
        chunkCount,
        errorCode,
      }),
    );
  if (!argument) throw new Error("缺少文件路径、查询或文档 ID");
  if (command === "search")
    return retrieveKnowledge(ownerId, baseOrName, argument, {
      repository,
      embedder: createKnowledgeEmbedder(),
    });
  if (command === "delete") {
    const document = await repository.deleteDocument(
      ownerId,
      baseOrName,
      argument,
    );
    if (document) await storage().deleteObject(document.objectKey);
    return { deleted: Boolean(document) };
  }
  if (command !== "upload") throw new Error("未知命令");
  await repository.requireOwner(ownerId, baseOrName);
  const mediaType = (
    {
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".pdf": "application/pdf",
    } as Record<string, string>
  )[extname(argument).toLowerCase()];
  const metadata = await stat(argument);
  if (
    !mediaType ||
    !metadata.isFile() ||
    !metadata.size ||
    metadata.size > KNOWLEDGE_MAX_BYTES
  )
    throw new Error("仅支持 10 MB 以内的 TXT、Markdown 和文本 PDF");
  const data = await readFile(argument);
  const objectKey = `knowledge/${randomUUID()}`;
  const objectStorage = storage();
  const document = await repository.createDocument(ownerId, baseOrName, {
    originalName: basename(argument),
    mediaType,
    sizeBytes: data.length,
    objectKey,
  });
  try {
    await objectStorage.writeObject({
      objectKey,
      data,
      contentType: mediaType,
      abortSignal: AbortSignal.timeout(60_000),
    });
    const connection = new IORedis(required("REDIS_URL"), {
      maxRetriesPerRequest: 1,
    });
    connection.on("error", () => {});
    const queue = new Queue(KNOWLEDGE_QUEUE, { connection });
    try {
      await queue.add(
        "ingest",
        { documentId: document.id },
        {
          jobId: document.id,
          attempts: 1,
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
    } finally {
      await queue.close();
      connection.disconnect();
    }
  } catch {
    await repository.fail(document.id, "UPLOAD_OR_ENQUEUE_FAILED");
    throw new Error(`文档 ${document.id} 上传或入队失败`);
  }
  return { documentId: document.id, status: "pending" };
}

try {
  console.info(JSON.stringify(await main(), null, 2));
} catch {
  console.error("知识库命令失败，请检查参数、配置和文档状态。");
  process.exitCode = 1;
} finally {
  await closeApplicationDatabase();
}
