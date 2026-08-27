import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  completeAttachmentUploadResponseSchema,
  createAttachmentUploadRequestSchema,
  createAttachmentUploadResponseSchema,
  deleteAttachmentResponseSchema,
} from "./attachment";
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

  it("attachment upload request/response 与 Schema 保持一致", () => {
    const request = readExample("attachment-upload.request.json");
    const response = readExample("attachment-upload.response.json");

    expect(createAttachmentUploadRequestSchema.parse(request)).toEqual(request);
    expect(createAttachmentUploadResponseSchema.parse(response)).toEqual(response);
  });

  it("attachment complete response 与 Schema 保持一致", () => {
    const response = readExample("attachment-complete.response.json");

    expect(completeAttachmentUploadResponseSchema.parse(response)).toEqual(
      response,
    );
  });

  it("attachment delete response 与 Schema 保持一致", () => {
    const response = readExample("attachment-delete.response.json");

    expect(deleteAttachmentResponseSchema.parse(response)).toEqual(response);
  });
});
