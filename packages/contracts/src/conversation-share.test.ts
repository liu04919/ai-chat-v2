import { describe, expect, it } from "vitest";

import {
  conversationShareSnapshotSchema,
  conversationShareStatusResponseSchema,
} from "./conversation-share";

const now = "2026-09-03T10:00:00.000Z";

describe("Conversation Share contracts", () => {
  it("快照保留可见消息和附件元数据", () => {
    expect(
      conversationShareSnapshotSchema.parse({
        version: 1,
        messages: [
          {
            id: "message-1",
            role: "assistant",
            sequence: 1,
            createdAt: now,
            parts: [
              { id: "reasoning-1", type: "reasoning", text: "思考" },
              { id: "tool-1", type: "tool-call", toolCallId: "call-1", toolName: "weather" },
              { id: "result-1", type: "tool-result", toolCallId: "call-1", isError: false },
              { id: "image-1", type: "attachment", attachmentId: "attachment-1" },
            ],
          },
        ],
        attachments: [
          {
            id: "attachment-1",
            originalName: "result.png",
            mediaType: "image/png",
            sizeBytes: 128,
          },
        ],
      }).attachments,
    ).toHaveLength(1);
  });

  it("分享状态不向客户端暴露快照正文或内部 token", () => {
    expect(
      conversationShareStatusResponseSchema.parse({
        share: {
          conversationId: "conversation-1",
          url: "https://example.com/share/token",
          createdAt: now,
        },
      }),
    ).toEqual({
      share: {
        conversationId: "conversation-1",
        url: "https://example.com/share/token",
        createdAt: now,
      },
    });
  });
});
