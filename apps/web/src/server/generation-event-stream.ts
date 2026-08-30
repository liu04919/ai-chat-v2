import type { GenerationEventCursor, GenerationStatusDto } from "@ai-chat/contracts";
import { getGenerationRecordForOwner } from "@ai-chat/db";
import {
  createRedisGenerationEventReader,
  type GenerationEventEntry,
  type GenerationEventReader,
} from "@ai-chat/event-store";

const START_CURSOR = "0-0" as GenerationEventCursor;
const DEFAULT_READ_LIMIT = 100;
const DEFAULT_BLOCK_MS = 15_000;
const encoder = new TextEncoder();

type FindGeneration = (
  ownerId: string,
  generationId: string,
) => Promise<{ id: string; status: GenerationStatusDto } | null>;

export type GenerationEventStreamDependencies = {
  findGeneration?: FindGeneration;
  createReader?: () => GenerationEventReader;
  readLimit?: number;
  blockMs?: number;
};

function isTerminalStatus(status: GenerationStatusDto): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isTerminalEntry(entry: GenerationEventEntry): boolean {
  return (
    entry.event.type === "generation.completed" ||
    entry.event.type === "generation.failed" ||
    entry.event.type === "generation.cancelled"
  );
}

function encodeEvent(entry: GenerationEventEntry): Uint8Array {
  return encoder.encode(
    `id: ${entry.cursor}\ndata: ${JSON.stringify(entry.event)}\n\n`,
  );
}

function encodeHeartbeat(): Uint8Array {
  return encoder.encode(": keep-alive\n\n");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} 必须是正整数`);
  }

  return value;
}

function createApplicationReader(): GenerationEventReader {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    throw new Error("缺少 REDIS_URL，无法订阅 Generation Event");
  }

  return createRedisGenerationEventReader({ redisUrl });
}

function createEventStream(input: {
  generationId: string;
  afterCursor?: GenerationEventCursor;
  terminalAtOpen: boolean;
  reader: GenerationEventReader;
  readLimit: number;
  blockMs: number;
}): ReadableStream<Uint8Array> {
  const abortController = new AbortController();
  let closePromise: Promise<void> | undefined;

  const closeReader = () => {
    closePromise ??= input.reader.close();
    return closePromise;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        let cursor = input.afterCursor;
        let errored = false;

        try {
          while (!abortController.signal.aborted) {
            const entries = await input.reader.read({
              generationId: input.generationId,
              ...(cursor ? { afterCursor: cursor } : {}),
              limit: input.readLimit,
            });

            if (entries.length === 0) {
              break;
            }

            for (const entry of entries) {
              if (abortController.signal.aborted) {
                return;
              }

              controller.enqueue(encodeEvent(entry));
              cursor = entry.cursor;

              if (isTerminalEntry(entry)) {
                return;
              }
            }

            if (entries.length < input.readLimit) {
              break;
            }
          }

          if (abortController.signal.aborted || input.terminalAtOpen) {
            return;
          }

          while (!abortController.signal.aborted) {
            const entries = await input.reader.readBlocking({
              generationId: input.generationId,
              afterCursor: cursor ?? START_CURSOR,
              limit: input.readLimit,
              blockMs: input.blockMs,
            });

            if (entries.length === 0) {
              controller.enqueue(encodeHeartbeat());
              continue;
            }

            for (const entry of entries) {
              if (abortController.signal.aborted) {
                return;
              }

              controller.enqueue(encodeEvent(entry));
              cursor = entry.cursor;

              if (isTerminalEntry(entry)) {
                return;
              }
            }
          }
        } catch (error) {
          if (!abortController.signal.aborted) {
            errored = true;
            controller.error(error);
          }
        } finally {
          await closeReader();

          if (!abortController.signal.aborted && !errored) {
            controller.close();
          }
        }
      })();
    },

    async cancel() {
      abortController.abort();
      await closeReader();
    },
  });
}

export async function openGenerationEventStreamForOwner(
  ownerId: string,
  generationId: string,
  afterCursor: GenerationEventCursor | undefined,
  dependencies: GenerationEventStreamDependencies = {},
): Promise<ReadableStream<Uint8Array> | null> {
  const generation = await (
    dependencies.findGeneration ?? getGenerationRecordForOwner
  )(ownerId, generationId);

  if (!generation) {
    return null;
  }

  return createEventStream({
    generationId,
    ...(afterCursor ? { afterCursor } : {}),
    terminalAtOpen: isTerminalStatus(generation.status),
    reader: (dependencies.createReader ?? createApplicationReader)(),
    readLimit: positiveInteger(
      dependencies.readLimit ?? DEFAULT_READ_LIMIT,
      "readLimit",
    ),
    blockMs: positiveInteger(dependencies.blockMs ?? DEFAULT_BLOCK_MS, "blockMs"),
  });
}
