import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createConversationRequestSchema } from "./conversation";
import { chatRuntimeStateSchema } from "./generation";

function readExample(name: string): unknown {
  const url = new URL(`../examples/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

describe("contract examples", () => {
  it("create-conversation request 与 Schema 保持一致", () => {
    const example = readExample("create-conversation.request.json");

    expect(createConversationRequestSchema.parse(example)).toEqual(example);
  });

  it("chat runtime state response 与 Schema 保持一致", () => {
    const example = readExample("chat-runtime-state.response.json");

    expect(chatRuntimeStateSchema.parse(example)).toEqual(example);
  });
});
