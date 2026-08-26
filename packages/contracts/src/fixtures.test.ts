import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  conversationDetailResponseSchema,
  conversationListResponseSchema,
} from "./conversation";

function readExample(name: string): unknown {
  const url = new URL(`../examples/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

describe("contract examples", () => {
  it("conversation list response 与 Schema 保持一致", () => {
    const example = readExample("conversation-list.response.json");

    expect(conversationListResponseSchema.parse(example)).toEqual(example);
  });

  it("conversation detail response 与 Schema 保持一致", () => {
    const example = readExample("conversation-detail.response.json");

    expect(conversationDetailResponseSchema.parse(example)).toEqual(example);
  });
});
