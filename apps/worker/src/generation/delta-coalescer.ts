import type { ChatModelStreamPart } from "../llm/chat-model";

export const DEFAULT_DELTA_MAX_DELAY_MS = 40;
export const DEFAULT_DELTA_MAX_CHARACTERS = 128;

type DeltaPart = Extract<
  ChatModelStreamPart,
  { type: "text" | "reasoning" }
>;

export type DeltaCoalescingOptions = {
  maxDelayMs?: number;
  maxCharacters?: number;
};

type NextResult = IteratorResult<ChatModelStreamPart>;
type NextOutcome =
  | { kind: "result"; result: NextResult }
  | { kind: "error"; error: unknown };

function assertPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} 必须是正整数`);
  }

  return value;
}

function waitForNextOrDeadline(
  next: Promise<NextOutcome>,
  delayMs: number,
): Promise<{ kind: "next"; outcome: NextOutcome } | { kind: "deadline" }> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ kind: "deadline" }), delayMs);

    void next.then((outcome) => {
      clearTimeout(timeout);
      resolve({ kind: "next", outcome });
    });
  });
}

function readNext(
  iterator: AsyncIterator<ChatModelStreamPart>,
): Promise<NextOutcome> {
  return iterator.next().then(
    (result) => ({ kind: "result", result }),
    (error: unknown) => ({ kind: "error", error }),
  );
}

export async function* coalesceChatModelStream(
  source: AsyncIterable<ChatModelStreamPart>,
  options: DeltaCoalescingOptions = {},
): AsyncIterable<ChatModelStreamPart> {
  const maxDelayMs = assertPositiveInteger(
    options.maxDelayMs ?? DEFAULT_DELTA_MAX_DELAY_MS,
    "maxDelayMs",
  );
  const maxCharacters = assertPositiveInteger(
    options.maxCharacters ?? DEFAULT_DELTA_MAX_CHARACTERS,
    "maxCharacters",
  );
  const iterator = source[Symbol.asyncIterator]();
  let next = readNext(iterator);
  let pending: DeltaPart | undefined;
  let deadline = 0;
  let hasEmittedFirstDelta = false;

  try {
    while (true) {
      let nextOutcome: NextOutcome;

      if (pending) {
        const outcome = await waitForNextOrDeadline(
          next,
          Math.max(0, deadline - Date.now()),
        );

        if (outcome.kind === "deadline") {
          yield pending;
          pending = undefined;
          continue;
        }

        nextOutcome = outcome.outcome;
      } else {
        nextOutcome = await next;
      }

      if (nextOutcome.kind === "error") {
        if (pending) {
          yield pending;
          pending = undefined;
        }

        throw nextOutcome.error;
      }

      const result = nextOutcome.result;

      if (result.done) {
        if (pending) {
          yield pending;
        }

        return;
      }

      const part = result.value;

      if (part.type === "finish") {
        if (pending) {
          yield pending;
          pending = undefined;
        }

        yield part;
        return;
      }

      next = readNext(iterator);

      if (part.delta.length === 0) {
        continue;
      }

      if (!hasEmittedFirstDelta) {
        hasEmittedFirstDelta = true;
        yield part;
        continue;
      }

      if (!pending) {
        pending = { ...part };
        deadline = Date.now() + maxDelayMs;
        continue;
      }

      if (pending.type !== part.type) {
        yield pending;
        pending = { ...part };
        deadline = Date.now() + maxDelayMs;
        continue;
      }

      pending.delta += part.delta;

      if (pending.delta.length >= maxCharacters) {
        yield pending;
        pending = undefined;
      }
    }
  } finally {
    await iterator.return?.();
  }
}
