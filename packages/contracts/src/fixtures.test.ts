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
import {
  createGenerationRequestSchema,
  createGenerationResponseSchema,
  generationErrorResponseSchema,
  generationJobPayloadSchema,
} from "./generation-command";

function readExample(name: string): unknown {
  const url = new URL(`../examples/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

describe("contract examples", () => {
  it("conversation list response 与 Schema 保持一致", () => {
    const example = readExample("http/conversation/list.response.json");

    expect(conversationListResponseSchema.parse(example)).toEqual(example);
  });

  it("conversation detail response 与 Schema 保持一致", () => {
    const example = readExample("http/conversation/detail.response.json");

    expect(conversationDetailResponseSchema.parse(example)).toEqual(example);
  });

  it("attachment upload request/response 与 Schema 保持一致", () => {
    const request = readExample("http/attachment/upload.request.json");
    const response = readExample("http/attachment/upload.response.json");

    expect(createAttachmentUploadRequestSchema.parse(request)).toEqual(request);
    expect(createAttachmentUploadResponseSchema.parse(response)).toEqual(response);
  });

  it("attachment complete response 与 Schema 保持一致", () => {
    const response = readExample("http/attachment/complete.response.json");

    expect(completeAttachmentUploadResponseSchema.parse(response)).toEqual(
      response,
    );
  });

  it("attachment delete response 与 Schema 保持一致", () => {
    const response = readExample("http/attachment/delete.response.json");

    expect(deleteAttachmentResponseSchema.parse(response)).toEqual(response);
  });

  it("generation create request/response 与 Schema 保持一致", () => {
    const request = readExample("http/generation/create.request.json");
    const response = readExample("http/generation/create.response.json");

    expect(createGenerationRequestSchema.parse(request)).toEqual(request);
    expect(createGenerationResponseSchema.parse(response)).toEqual(response);
  });

  it("generation error 与 Worker job 示例保持一致", () => {
    const error = readExample("http/generation/active.error.json");
    const job = readExample("worker/generation.job.json");

    expect(generationErrorResponseSchema.parse(error)).toEqual(error);
    expect(generationJobPayloadSchema.parse(job)).toEqual(job);
  });
});
