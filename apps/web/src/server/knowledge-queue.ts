import { KNOWLEDGE_QUEUE } from "@ai-chat/contracts";
import { Queue } from "bullmq";
import IORedis from "ioredis";

export async function enqueueKnowledge(documentId: string) {
  if (!process.env.REDIS_URL) throw new Error("REDIS_NOT_CONFIGURED");
  const connection = new IORedis(process.env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  connection.on("error", () => {});
  const queue = new Queue(KNOWLEDGE_QUEUE, { connection });
  queue.on("error", () => {});
  try {
    await queue.add(
      "ingest",
      { documentId },
      {
        jobId: documentId,
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
  } finally {
    await queue.close();
    connection.disconnect();
  }
}
