import { KNOWLEDGE_QUEUE, knowledgeJobSchema } from "@ai-chat/contracts";
import { Worker } from "bullmq";
import IORedis from "ioredis";

export function createKnowledgeWorker(
  redisUrl: string,
  processDocument: (id: string) => Promise<void>,
  queueName = KNOWLEDGE_QUEUE,
) {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  connection.on("error", () => {});
  const worker = new Worker(
    queueName,
    async (job) => {
      const { documentId } = knowledgeJobSchema.parse(job.data);
      await processDocument(documentId);
    },
    { connection, concurrency: 1 },
  );
  worker.on("error", () => console.error("Knowledge Worker 连接异常"));
  worker.on("failed", (job) =>
    console.error(`Knowledge job ${job?.id ?? "unknown"} 失败`),
  );
  return {
    waitUntilReady: () => worker.waitUntilReady(),
    async close() {
      await worker.close();
      connection.disconnect();
    },
  };
}
